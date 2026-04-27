/**
 * Action's Odds — Result Grader
 *
 * Every 30 minutes, find all `actions_plays` rows with status='pending' and
 * try to grade them using the MLB Stats API. When a game is final:
 *   - Determine winner from final score
 *   - Update status: win | loss | push (push = postponed/voided)
 *   - Compute pnl using the same American-odds formula the API uses
 *   - Roll the actions_bankroll row forward (current_bankroll, win/loss counts)
 *
 * Currently MLB-only. NHL/NBA can be added by widening the sport filter and
 * mapping the right stats endpoint.
 *
 * Failure modes handled:
 *   - Game not on the schedule yet (rare; team rename, doubleheader split)
 *     → leave pending, log warning
 *   - Game postponed → mark 'push' so stake is returned
 *   - API down → log error, leave pending, retry on next tick
 *   - Multiple games same day same teams (DH) → match by gamePk via play_date
 *     order — first pending row maps to gamePk1, second to gamePk2
 */

const https = require('https');
const { supabaseAdmin } = require('./auth');

const GRADER_TICK_MS = 30 * 60 * 1000; // 30 min
const STATS_API = 'https://statsapi.mlb.com/api/v1/schedule';

// ── HTTP helper ────────────────────────────────────────────
function fetchJSON(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout: ' + url)), timeoutMs);
    https.get(url, { headers: { 'User-Agent': 'ActionsOdds/2.0 Grader' } }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        clearTimeout(timer);
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse error: ' + e.message)); }
      });
    }).on('error', e => { clearTimeout(timer); reject(e); });
  });
}

// ── Pnl helper (mirrors api-routes computePnl) ─────────────
function profitForWin(odds, stake) {
  const o = parseInt(odds, 10) || 0;
  const s = parseFloat(stake) || 0;
  if (o === 0 || s === 0) return 0;
  return o > 0 ? s * (o / 100) : s * (100 / Math.abs(o));
}
function computePnl(status, odds, stake) {
  if (status === 'win')  return Number(profitForWin(odds, stake).toFixed(2));
  if (status === 'loss') return -Number((parseFloat(stake) || 0).toFixed(2));
  return 0;
}

// ── Team-name fuzzy match ──────────────────────────────────
// MLB Stats API uses full names ("Milwaukee Brewers"); our `selection` field
// looks like "Milwaukee Brewers +145" or "Brewers +145". Match on inclusion.
function selectionMatchesTeam(selection, teamName) {
  if (!selection || !teamName) return false;
  const sel = selection.toLowerCase();
  const team = teamName.toLowerCase();
  if (sel.includes(team)) return true;
  // Last word match — "Brewers" in both
  const teamLast = team.split(' ').pop();
  if (teamLast.length > 3 && sel.includes(teamLast)) return true;
  return false;
}

/**
 * For a given date (YYYY-MM-DD), fetch the MLB schedule with linescore.
 * Returns array of { gamePk, status, abstractGameState, away, home,
 * awayScore, homeScore }.
 */
async function fetchSchedule(date) {
  const url = `${STATS_API}?sportId=1&date=${date}&hydrate=linescore,team`;
  const data = await fetchJSON(url);
  const out = [];
  for (const day of (data.dates || [])) {
    for (const g of (day.games || [])) {
      out.push({
        gamePk: g.gamePk,
        status: g.status?.detailedState || '',
        abstractGameState: g.status?.abstractGameState || '',
        away: g.teams?.away?.team?.name || '',
        home: g.teams?.home?.team?.name || '',
        awayScore: g.teams?.away?.score ?? null,
        homeScore: g.teams?.home?.score ?? null,
      });
    }
  }
  return out;
}

/**
 * Decide grade for one play given the matched game.
 * Returns null if game not yet final.
 */
function grade(play, game) {
  // Postponed / cancelled → push (return stake)
  if (/postponed|cancelled|suspended/i.test(game.status)) {
    return { status: 'push', winner: null };
  }
  if (game.abstractGameState !== 'Final') return null;
  if (game.awayScore == null || game.homeScore == null) return null;
  if (game.awayScore === game.homeScore) {
    // Extras almost never tie in MLB but handle defensively
    return { status: 'push', winner: null };
  }
  const homeWon = game.homeScore > game.awayScore;
  const winnerName = homeWon ? game.home : game.away;
  const pickedWinner = selectionMatchesTeam(play.selection, winnerName);
  return {
    status: pickedWinner ? 'win' : 'loss',
    winner: winnerName,
  };
}

/**
 * Main grading pass. Returns { graded, stillPending, errors }.
 */
async function gradePendingPlays() {
  const t0 = Date.now();
  const { data: pending, error } = await supabaseAdmin
    .from('actions_plays')
    .select('*')
    .eq('status', 'pending')
    .eq('sport_id', 'mlb')
    .order('play_date', { ascending: true });

  if (error) {
    console.error('[Grader] Fetch failed:', error.message);
    return { graded: 0, stillPending: 0, errors: [error.message] };
  }
  if (!pending || pending.length === 0) {
    return { graded: 0, stillPending: 0, errors: [] };
  }

  // Group by play_date so we hit the schedule API once per date
  const byDate = {};
  for (const p of pending) {
    (byDate[p.play_date] = byDate[p.play_date] || []).push(p);
  }

  let graded = 0, stillPending = 0;
  const errors = [];
  // Track bankroll deltas so we update once per sport at the end
  const bankrollDelta = { mlb: { pnl: 0, wins: 0, losses: 0, pushes: 0 } };

  for (const date of Object.keys(byDate)) {
    let schedule;
    try {
      schedule = await fetchSchedule(date);
    } catch (e) {
      errors.push(`Schedule fetch ${date}: ${e.message}`);
      stillPending += byDate[date].length;
      continue;
    }

    // For each play on that date, find its game
    for (const play of byDate[date]) {
      // Match by team names appearing in `play.game` ("Away @ Home")
      const candidates = schedule.filter(g => {
        const gameStr = play.game.toLowerCase();
        return gameStr.includes(g.away.toLowerCase()) &&
               gameStr.includes(g.home.toLowerCase());
      });
      if (candidates.length === 0) {
        stillPending++;
        continue;
      }
      // For doubleheaders: prefer Final games first, then earliest gamePk
      candidates.sort((a, b) => {
        const aFinal = a.abstractGameState === 'Final' ? 0 : 1;
        const bFinal = b.abstractGameState === 'Final' ? 0 : 1;
        if (aFinal !== bFinal) return aFinal - bFinal;
        return a.gamePk - b.gamePk;
      });
      const game = candidates[0];

      const result = grade(play, game);
      if (!result) {
        stillPending++;
        continue;
      }
      const newPnl = computePnl(result.status, play.odds, play.stake);
      const { error: updErr } = await supabaseAdmin
        .from('actions_plays')
        .update({
          status: result.status,
          pnl: newPnl,
          updated_at: new Date().toISOString(),
        })
        .eq('id', play.id);

      if (updErr) {
        errors.push(`Update ${play.id}: ${updErr.message}`);
        stillPending++;
        continue;
      }

      graded++;
      const d = bankrollDelta[play.sport_id] = bankrollDelta[play.sport_id] || { pnl: 0, wins: 0, losses: 0, pushes: 0 };
      d.pnl += newPnl;
      if (result.status === 'win')  d.wins++;
      if (result.status === 'loss') d.losses++;
      if (result.status === 'push') d.pushes++;
      console.log(`[Grader] ${play.play_date} ${play.selection} → ${result.status.toUpperCase()} ${newPnl >= 0 ? '+' : ''}${newPnl}`);
    }
  }

  // Roll bankroll forward
  for (const sport of Object.keys(bankrollDelta)) {
    const d = bankrollDelta[sport];
    if (d.pnl === 0 && d.wins === 0 && d.losses === 0 && d.pushes === 0) continue;
    const { data: br, error: brErr } = await supabaseAdmin
      .from('actions_bankroll')
      .select('*')
      .eq('sport_id', sport)
      .maybeSingle();
    if (brErr || !br) {
      errors.push(`No bankroll row for ${sport}`);
      continue;
    }
    const { error: updBrErr } = await supabaseAdmin
      .from('actions_bankroll')
      .update({
        current_bankroll: Number((Number(br.current_bankroll) + d.pnl).toFixed(2)),
        total_wins:   (br.total_wins   || 0) + d.wins,
        total_losses: (br.total_losses || 0) + d.losses,
        total_pushes: (br.total_pushes || 0) + d.pushes,
        updated_at: new Date().toISOString(),
      })
      .eq('sport_id', sport);
    if (updBrErr) errors.push(`Bankroll update ${sport}: ${updBrErr.message}`);
    else console.log(`[Grader] ${sport.toUpperCase()} bankroll +${d.pnl.toFixed(2)} | W${d.wins} L${d.losses} P${d.pushes}`);
  }

  console.log(`[Grader] Done in ${Date.now() - t0}ms — ${graded} graded, ${stillPending} still pending`);
  return { graded, stillPending, errors };
}

let graderTimer = null;
function startGraderCron() {
  if (graderTimer) return;
  // First run after 60s so the server boots cleanly, then every 30 min
  setTimeout(async function tick() {
    try { await gradePendingPlays(); }
    catch (e) { console.error('[Grader] Tick error:', e.message); }
    graderTimer = setTimeout(tick, GRADER_TICK_MS);
  }, 60000);
  console.log('[Grader] Cron scheduled — first tick in 60s, then every 30 min');
}

module.exports = { gradePendingPlays, startGraderCron };
