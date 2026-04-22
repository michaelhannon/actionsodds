// ============================================================
// ACTION'S ODDS — Full Morning Scan Engine v2
// Runs at 9AM ET daily — complete T1-T15 + R1-R7 evaluation
// Outputs ready-to-bet card with sizing, color, strength badge
// ============================================================

const https = require('https');

// ── SYSTEM CONFIG ────────────────────────────────────────────
const MLB_MEAN_ROAD = 0.47;
const MLB_MEAN_HOME = 0.53;
const REGRESSION_THRESHOLD = 0.15;

const DOME_PARKS = [
  'Tropicana Field','Rogers Centre','Minute Maid Park',
  'American Family Field','Chase Field','T-Mobile Park',
  'Globe Life Field','Petco Park'
];

const HITTER_PARKS = ['Coors Field','Fenway Park','Great American Ball Park','Minute Maid Park'];
const PITCHER_PARKS = ['Oracle Park','PNC Park','Petco Park','Dodger Stadium'];

// ── CACHE ────────────────────────────────────────────────────
let lastScan = null;
let scanInProgress = false;
function getLastScan() { return lastScan; }

// ── HTTP HELPER ──────────────────────────────────────────────
function fetchJSON(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout: ' + url)), timeoutMs || 8000);
    https.get(url, { headers: { 'User-Agent': 'ActionsOdds/2.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        clearTimeout(timer);
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('JSON parse error')); }
      });
    }).on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

// ── STEP 1: ALL 30 TEAMS — STREAKS, RUN DIFF, SPLITS ────────
async function fetchStandings() {
  try {
    const url = 'https://statsapi.mlb.com/api/v1/standings?leagueId=103,104&season=2026&standingsTypes=regularSeason&hydrate=team,record,streak';
    const data = await fetchJSON(url);
    const teams = {};
    for (const record of (data.records || [])) {
      for (const tr of (record.teamRecords || [])) {
        const abbr = tr.team?.abbreviation;
        if (!abbr) continue;
        const wins = tr.wins || 0;
        const losses = tr.losses || 0;
        const runsScored = tr.runsScored || 0;
        const runsAllowed = tr.runsAllowed || 0;
        const streakCode = tr.streak?.streakCode || 'W0';
        const streakType = streakCode.startsWith('W') ? 'W' : 'L';
        const streakLen = parseInt(streakCode.slice(1)) || 0;
        // Split records
        const splits = tr.records?.splitRecords || [];
        const homeSplit = splits.find(s => s.type === 'home') || {};
        const roadSplit = splits.find(s => s.type === 'away') || {};
        const homeW = homeSplit.wins || 0, homeL = homeSplit.losses || 0;
        const roadW = roadSplit.wins || 0, roadL = roadSplit.losses || 0;
        const homeTotal = homeW + homeL;
        const roadTotal = roadW + roadL;
        const homePct = homeTotal >= 5 ? homeW / homeTotal : 0.5;
        const roadPct = roadTotal >= 5 ? roadW / roadTotal : 0.5;
        const runDiff = runsScored - runsAllowed;
        // T4 regression flag
        let regressionFlag = null;
        if (roadTotal >= 5 && roadPct < (MLB_MEAN_ROAD - REGRESSION_THRESHOLD)) {
          regressionFlag = { type: 'road_due', pct: Math.round(roadPct * 100), boost: '+T4 when road dog' };
        } else if (homeTotal >= 5 && homePct < (MLB_MEAN_HOME - REGRESSION_THRESHOLD)) {
          regressionFlag = { type: 'home_due', pct: Math.round(homePct * 100), boost: '+T4 when home dog' };
        }
        teams[abbr] = {
          name: tr.team?.name || abbr, abbr,
          wins, losses, runDiff,
          streak: streakType, streakLen,
          homeW, homeL, homePct: Math.round(homePct * 100),
          roadW, roadL, roadPct: Math.round(roadPct * 100),
          homeTotal, roadTotal, regressionFlag,
          teamId: tr.team?.id
        };
      }
    }
    return teams;
  } catch(e) {
    console.error('[Scan] Standings error:', e.message);
    return {};
  }
}

// ── STEP 2: TODAY'S SCHEDULE ─────────────────────────────────
async function fetchSchedule() {
  try {
    const today = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in local time
    const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${today}&hydrate=probablePitcher,team,venue`;
    const data = await fetchJSON(url);
    const games = [];
    for (const dateEntry of (data.dates || [])) {
      for (const g of (dateEntry.games || [])) {
        if (g.status?.abstractGameState === 'Final') continue; // skip completed
        games.push({
          gameId: g.gamePk,
          gameTime: g.gameDate,
          venue: g.venue?.name || '',
          away: {
            abbr: g.teams?.away?.team?.abbreviation,
            name: g.teams?.away?.team?.name,
            id: g.teams?.away?.team?.id,
            pitcher: g.teams?.away?.probablePitcher || null
          },
          home: {
            abbr: g.teams?.home?.team?.abbreviation,
            name: g.teams?.home?.team?.name,
            id: g.teams?.home?.team?.id,
            pitcher: g.teams?.home?.probablePitcher || null
          }
        });
      }
    }
    return games;
  } catch(e) {
    console.error('[Scan] Schedule error:', e.message);
    return [];
  }
}

// ── STEP 3: PITCHER STATS (ERA, FIP proxy, WHIP, K9, BB9) ───
async function fetchPitcherStats(pitcherId) {
  if (!pitcherId) return null;
  try {
    const url = `https://statsapi.mlb.com/api/v1/people/${pitcherId}/stats?stats=season,lastXGames&group=pitching&season=2026&sitCodes=vr,vl`;
    const data = await fetchJSON(url, 5000);
    const season = data.stats?.find(s => s.type?.displayName === 'statsSingleSeason')?.splits?.[0]?.stat;
    const last3 = data.stats?.find(s => s.type?.displayName === 'lastXGames')?.splits?.slice(0, 3) || [];
    if (!season) return null;
    const ip = parseFloat(season.inningsPitched) || 1;
    const era = parseFloat(season.era) || 0;
    const whip = parseFloat(season.whip) || 0;
    const k9 = parseFloat(season.strikeoutsPer9Inn) || 0;
    const bb9 = parseFloat(season.walksPer9Inn) || 0;
    const hr9 = ((season.homeRuns || 0) / ip * 9);
    // FIP proxy: (13*HR + 3*BB - 2*K) / IP + constant(3.2)
    const k = season.strikeOuts || 0;
    const bb = season.baseOnBalls || 0;
    const hr = season.homeRuns || 0;
    const fip = ip > 0 ? ((13 * hr + 3 * bb - 2 * k) / ip + 3.2) : era;
    const last3ERA = last3.length ?
      last3.reduce((a, s) => a + (parseFloat(s.stat?.era) || 0), 0) / last3.length : era;
    return { era, fip: Math.round(fip * 100) / 100, whip, k9, bb9, hr9, last3ERA, ip, wins: season.wins || 0, losses: season.losses || 0 };
  } catch(e) {
    return null;
  }
}

// ── STEP 4: BULLPEN 48HR DEPLETION ───────────────────────────
async function fetchBullpenStatus(teamId) {
  if (!teamId) return null;
  try {
    // Get team roster bullpen
    const rosterUrl = `https://statsapi.mlb.com/api/v1/teams/${teamId}/roster?rosterType=active&season=2026`;
    const roster = await fetchJSON(rosterUrl, 5000);
    const relievers = (roster.roster || []).filter(p =>
      p.position?.abbreviation === 'RP' || p.position?.abbreviation === 'CL'
    );
    // Get recent game log for the team — check pitching last 2 days
    const today = new Date();
    const twoDaysAgo = new Date(today - 2 * 24 * 60 * 60 * 1000).toLocaleDateString('en-CA');
    const schedUrl = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&startDate=${twoDaysAgo}&endDate=${today.toLocaleDateString('en-CA')}&teamId=${teamId}&hydrate=linescore`;
    const sched = await fetchJSON(schedUrl, 5000);
    let recentInnings = 0;
    let gameCount = 0;
    for (const d of (sched.dates || [])) {
      for (const g of (d.games || [])) {
        if (g.status?.abstractGameState === 'Final') {
          gameCount++;
          const innings = g.linescore?.innings?.length || 9;
          if (innings > 9) recentInnings += (innings - 9); // extra innings = more pen usage
        }
      }
    }
    const depleted = gameCount >= 2 || recentInnings >= 3;
    const closerAvail = true; // assume available unless we find IL data
    return {
      relievers: relievers.length,
      recentGames: gameCount,
      extraInnings: recentInnings,
      depleted,
      closerAvail,
      note: depleted ? `BP depleted — ${gameCount} games in 48hrs${recentInnings > 0 ? ', ' + recentInnings + ' extra innings' : ''}` : 'BP fresh'
    };
  } catch(e) {
    return { depleted: false, note: 'BP data unavailable', relievers: 0 };
  }
}

// ── STEP 5: LIVE ODDS ────────────────────────────────────────
async function fetchOdds(apiKey) {
  if (!apiKey) return [];
  try {
    const url = `https://api.the-odds-api.com/v4/sports/baseball_mlb/odds/?apiKey=${apiKey}&regions=us&markets=h2h,spreads&oddsFormat=american&bookmakers=draftkings,fanduel,betmgm,caesars`;
    return await fetchJSON(url);
  } catch(e) {
    console.error('[Scan] Odds error:', e.message);
    return [];
  }
}

// ── TRIGGER ENGINE ───────────────────────────────────────────
function runTriggerEngine(game, teams, odds, awayPitcherStats, homePitcherStats, awayBullpen, homeBullpen, cfg) {
  const t1Min = cfg.t1Min || 140;
  const t1Max = cfg.t1Max || 199;
  const t11Min = cfg.t11Min || 115;
  const t11Max = cfg.t11Max || 135;
  const t12Min = cfg.t12Min || 110;

  const away = teams[game.away.abbr] || {};
  const home = teams[game.home.abbr] || {};

  // Get odds for this game
  const gameOdds = odds.find(o => {
    const hn = o.home_team || '';
    const an = o.away_team || '';
    return hn.includes(game.home.abbr) || hn === game.home.name ||
           an.includes(game.away.abbr) || an === game.away.name ||
           game.home.name?.includes(hn.split(' ').pop()) ||
           game.away.name?.includes(an.split(' ').pop());
  });

  let homeML = null, awayML = null, homeRL = null, awayRL = null;
  if (gameOdds) {
    const bm = gameOdds.bookmakers?.find(b => ['draftkings','fanduel','betmgm','caesars'].includes(b.key)) || gameOdds.bookmakers?.[0];
    const h2h = bm?.markets?.find(m => m.key === 'h2h');
    const spreads = bm?.markets?.find(m => m.key === 'spreads');
    homeML = h2h?.outcomes?.find(o => o.name === gameOdds.home_team)?.price;
    awayML = h2h?.outcomes?.find(o => o.name === gameOdds.away_team)?.price;
    homeRL = spreads?.outcomes?.find(o => o.name === gameOdds.home_team);
    awayRL = spreads?.outcomes?.find(o => o.name === gameOdds.away_team);
  }

  // ── GATE CHECK ───────────────────────────────────────────
  let gateType = null;
  let gateML = null;
  let gateSide = null;

  if (homeML != null) {
    if (homeML >= t1Min && homeML <= t1Max) {
      gateType = 'T1'; gateML = homeML; gateSide = 'home';
    } else if (homeML < 0 && Math.abs(homeML) >= t11Min && Math.abs(homeML) <= t11Max) {
      gateType = 'T11'; gateML = homeML; gateSide = 'home';
    } else if (homeML >= t12Min && homeML < t1Min) {
      gateType = 'T12'; gateML = homeML; gateSide = 'home';
    }
  }
  if (!gateType && awayML != null && awayML >= 120) {
    gateType = 'T13'; gateML = awayML; gateSide = 'away';
  }
  // T15: Home fade — road dog backing
  let t15Active = false;
  if (awayML != null && awayML >= 120) {
    const f1 = home.streakLen >= 2 && home.streak === 'L'; // home L2+
    const f2 = home.runDiff < 0;                            // home neg diff
    const f3 = away.runDiff > 0;                            // road pos diff
    const f4 = away.streak === 'W' && away.streakLen >= 2;  // road W2+
    const f5 = homeBullpen?.depleted;                       // home bp depleted
    const f6 = (away.wins - away.losses) > (home.wins - home.losses); // road superior record
    const filtersHit = [f1,f2,f3,f4,f5,f6].filter(Boolean).length;
    if (filtersHit >= 5) t15Active = true;
  }

  if (!gateType && !t15Active) {
    return { gateType: null, plays: [], t15: false, collision: buildCollisionData(away, home), odds: { homeML, awayML } };
  }

  // ── TRIGGER COUNTING ─────────────────────────────────────
  const triggered = [];
  const failed = [];
  const notes = [];

  // T2: Streak collision
  const collisionActive = away.streak !== home.streak;
  const collisionMax = collisionActive && (away.streakLen >= 5 || home.streakLen >= 5);
  const fadeZone = away.streakLen >= 9 || home.streakLen >= 9;
  if (collisionActive) {
    const favSide = gateSide === 'home' ?
      (home.streak === 'W' ? 'T2 ✓ Home W' + home.streakLen + ' vs Away L' + away.streakLen : 'T2 ✓ Away L' + away.streakLen + ' vs Home W' + home.streakLen) :
      (away.streak === 'W' ? 'T2 ✓ Away W' + away.streakLen + ' vs Home L' + home.streakLen : null);
    if (favSide) {
      triggered.push('T2');
      notes.push(favSide + (collisionMax ? ' — MAX COLLISION' : ''));
    } else {
      failed.push('T2');
      notes.push('T2 ✗ Collision favors wrong side');
    }
  } else {
    failed.push('T2');
    notes.push('T2 ✗ No streak mismatch');
  }

  // T3: Run differential
  const gradeTeam = gateSide === 'home' ? home : away;
  const oppTeam = gateSide === 'home' ? away : home;
  if (gradeTeam.runDiff > 0) {
    triggered.push('T3');
    notes.push(`T3 ✓ ${gradeTeam.abbr} run diff ${gradeTeam.runDiff > 0 ? '+' : ''}${gradeTeam.runDiff}`);
  } else if (gradeTeam.runDiff < -10) {
    failed.push('T3');
    notes.push(`T3 ✗ ${gradeTeam.abbr} run diff ${gradeTeam.runDiff} — kills play`);
  } else {
    notes.push(`T3 ~ ${gradeTeam.abbr} run diff ${gradeTeam.runDiff} — neutral`);
  }

  // T4: Home/away split regression
  const regFlag = gradeTeam.regressionFlag;
  if (regFlag) {
    triggered.push('T4');
    notes.push(`T4 ✓ Regression due — ${gradeTeam.abbr} ${regFlag.type.replace('_',' ')} ${regFlag.pct}% (mean ${regFlag.type.includes('road') ? '47' : '53'}%)`);
  } else {
    notes.push(`T4 ~ No regression flag for ${gradeTeam.abbr}`);
  }

  // T6: Pitcher FIP (most important)
  const pitSide = gateSide === 'home' ? homePitcherStats : awayPitcherStats;
  const oppPit = gateSide === 'home' ? awayPitcherStats : homePitcherStats;
  const pitName = gateSide === 'home' ? game.home.pitcher?.fullName : game.away.pitcher?.fullName;
  const oppPitName = gateSide === 'home' ? game.away.pitcher?.fullName : game.home.pitcher?.fullName;

  if (pitSide && oppPit) {
    if (pitSide.fip <= oppPit.fip - 0.3) {
      triggered.push('T6');
      notes.push(`T6 ✓ ${pitName || 'SP'} FIP ${pitSide.fip} vs opp ${oppPit.fip} — edge confirmed`);
    } else if (pitSide.fip >= oppPit.fip + 0.5) {
      failed.push('T6');
      notes.push(`T6 ✗ ${pitName || 'SP'} FIP ${pitSide.fip} worse than opp ${oppPit.fip}`);
    } else {
      notes.push(`T6 ~ FIP near-even: ${pitSide.fip} vs ${oppPit.fip}`);
    }
  } else if (pitSide) {
    if (pitSide.era <= 3.50 && pitSide.fip <= 4.0) {
      triggered.push('T6');
      notes.push(`T6 ✓ ${pitName || 'SP'} ERA ${pitSide.era} FIP ${pitSide.fip} — solid`);
    } else {
      notes.push(`T6 ~ ${pitName || 'SP'} ERA ${pitSide.era} FIP ${pitSide.fip} — neutral`);
    }
  } else {
    notes.push('T6 ~ Pitcher data unavailable — check manually');
  }

  // T8: Bullpen depletion — mandatory check
  const oppBullpen = gateSide === 'home' ? awayBullpen : homeBullpen;
  const ourBullpen = gateSide === 'home' ? homeBullpen : awayBullpen;
  if (oppBullpen?.depleted) {
    triggered.push('T8');
    notes.push(`T8 ✓ Opp bullpen depleted — ${oppBullpen.note}`);
  } else if (ourBullpen?.depleted) {
    failed.push('T8');
    notes.push(`T8 ✗ Our bullpen depleted — ${ourBullpen.note}`);
  } else {
    notes.push(`T8 ~ Bullpen status: ${oppBullpen?.note || 'data unavailable'}`);
  }

  // T9: Schedule/fatigue
  const gameTime = new Date(game.gameTime);
  const hour = gameTime.getUTCHours();
  const isNight = hour >= 22; // late night West Coast
  if (isNight && gateSide === 'home') {
    notes.push('T9 ~ Late game — check travel fatigue on away team');
  }

  // T10: Divisional familiarity
  const isDivisional = away.division === home.division; // approximate
  if (isDivisional) {
    triggered.push('T10');
    notes.push('T10 ✓ Divisional matchup — counts as 2 triggers if T1 active');
  }

  // T14: Power ratings — mandatory kill check
  const awayPower = (away.wins - away.losses) + (away.runDiff / 10);
  const homePower = (home.wins - home.losses) + (home.runDiff / 10);
  const powerGap = Math.abs(awayPower - homePower);
  const favoredPower = homePower > awayPower ? 'home' : 'away';
  let t14Kill = false;

  if (gateType === 'T13' && favoredPower === 'home' && powerGap >= 15) {
    t14Kill = true;
    notes.push(`T14 ✗ KILL — Home power rating exceeds road dog by ${Math.round(powerGap)} pts`);
  } else if (gateType === 'T1' && powerGap >= 20 && favoredPower !== 'home') {
    notes.push(`T14 ⚠ Power gap ${Math.round(powerGap)} pts — need 4+ triggers`);
  } else {
    notes.push(`T14 ✓ Power ratings clear — gap ${Math.round(powerGap)} pts`);
  }

  // ── R-TRIGGERS ───────────────────────────────────────────
  // R1: Bounce back — team snapped a losing streak recently
  if (gradeTeam.streak === 'W' && gradeTeam.streakLen <= 2 && gradeTeam.prevStreak === 'L') {
    triggered.push('R1');
    notes.push('R1 ✓ Bounce back — recent losing streak ended');
  }

  // R2: Contrarian — if public data available (placeholder)
  // notes.push('R2 ~ Public % unavailable — check manually');

  // R3: Letdown spot — opponent coming off big win
  if (oppTeam.streak === 'W' && oppTeam.streakLen >= 3) {
    triggered.push('R3');
    notes.push(`R3 ✓ Letdown spot — opponent on W${oppTeam.streakLen}, potential trap`);
  }

  // R4: Must-win / desperation
  if (gradeTeam.streak === 'L' && gradeTeam.streakLen >= 4) {
    triggered.push('R4');
    notes.push(`R4 ✓ Must-win desperation — ${gradeTeam.abbr} on L${gradeTeam.streakLen}`);
  }

  // R5: Seasonal pattern — April underdog peak
  const month = new Date().getMonth();
  if (month === 3 && gateML > 0) { // April = month 3
    triggered.push('R5');
    notes.push('R5 ✓ April seasonal edge — underdog ROI peak month');
  }

  // R7: Blowout recovery
  if (gradeTeam.streak === 'L' && gradeTeam.streakLen === 1) {
    notes.push('R7 ~ Check last margin — if loss by 10+, 56% ATS cover rate');
  }

  // Ballpark T5 note (totals only)
  const isDome = DOME_PARKS.some(d => game.venue?.includes(d.split(' ')[0]));
  const isHitter = HITTER_PARKS.some(p => game.venue?.includes(p.split(' ')[0]));
  const isPitcher = PITCHER_PARKS.some(p => game.venue?.includes(p.split(' ')[0]));
  if (isDome) notes.push('T7 ~ Dome park — weather irrelevant');
  else if (isHitter) notes.push('T5 ~ Hitter park — check total');
  else if (isPitcher) notes.push('T5 ~ Pitcher park — under lean');

  // ── SIZING ───────────────────────────────────────────────
  let trigCount = triggered.length;

  // T10 divisional doubles if T1
  if (triggered.includes('T10') && gateType === 'T1') trigCount++;

  // Collision max = gate alone sufficient
  const gateAlone = collisionMax && (away.streakLen >= 5 || home.streakLen >= 5);

  // Kill if T14 fired
  if (t14Kill) trigCount = 0;

  // T11/T12/T13 max size caps
  let maxSize = 1000;
  if (gateType === 'T11') maxSize = 800;
  if (gateType === 'T12') maxSize = 600;
  if (gateType === 'T13') maxSize = 400;
  if (t15Active) maxSize = 100; // exotic only

  const unit = cfg.unit || 200;
  let sizing = 0;
  if (!t14Kill) {
    if (trigCount === 0 || (gateType === 'T1' && trigCount < 1)) sizing = unit;
    else if (trigCount === 1) sizing = unit * 2;
    else if (trigCount === 2) sizing = unit * 3;
    else if (trigCount === 3) sizing = unit * 4;
    else sizing = unit * 5;
    sizing = Math.min(sizing, maxSize);
  }

  // T11 needs 3+ triggers minimum
  if (gateType === 'T11' && trigCount < 3) sizing = 0;
  // T12 needs 5+ triggers minimum
  if (gateType === 'T12' && trigCount < 5) sizing = 0;
  // T13 needs ALL 5 of: T2+T3+T6+T8+1 more
  if (gateType === 'T13') {
    const req = ['T2','T3','T6','T8'];
    const hasAll = req.every(t => triggered.includes(t));
    if (!hasAll || trigCount < 5) sizing = 0;
  }

  // ── COLOR + STRENGTH ─────────────────────────────────────
  let color, strength, recommendation;
  if (t14Kill || sizing === 0) {
    color = 'red'; strength = 'PASS';
    recommendation = 'PASS — ' + (t14Kill ? 'T14 power ratings kill this play' : 'Insufficient triggers');
  } else if (t15Active) {
    color = 'orange'; strength = 'FADE';
    recommendation = `T15 FADE — ${game.away.name} (exotic/parlay only, $50-100)`;
  } else if (trigCount >= 4 || collisionMax) {
    color = 'blue'; strength = 'MAX';
    recommendation = `${gateSide === 'home' ? game.home.name : game.away.name} ML ${gateML > 0 ? '+' : ''}${gateML} — $${sizing}`;
  } else if (trigCount === 3) {
    color = 'green'; strength = 'STRONG';
    recommendation = `${gateSide === 'home' ? game.home.name : game.away.name} ML ${gateML > 0 ? '+' : ''}${gateML} — $${sizing}`;
  } else if (trigCount === 2) {
    color = 'teal'; strength = 'ENTRY';
    recommendation = `${gateSide === 'home' ? game.home.name : game.away.name} ML ${gateML > 0 ? '+' : ''}${gateML} — $${sizing}`;
  } else {
    color = 'amber'; strength = 'WATCH';
    recommendation = `${gateSide === 'home' ? game.home.name : game.away.name} ML ${gateML > 0 ? '+' : ''}${gateML} — $${sizing} (borderline)`;
  }

  // Run line add-on
  let rlAddon = null;
  if (sizing > 0 && !t14Kill && !t15Active && trigCount >= 4) {
    if (gateSide === 'home' && awayRL?.price >= 115) {
      rlAddon = { desc: `${game.away.name} -1.5 +${awayRL.price}`, amt: Math.round(sizing * 0.5) };
    } else if (gateSide === 'away' && homeRL?.price >= 115) {
      rlAddon = { desc: `${game.home.name} -1.5 +${homeRL.price}`, amt: Math.round(sizing * 0.5) };
    }
  }

  return {
    gateType, gateML, gateSide,
    triggered, failed, notes,
    trigCount, sizing, color, strength,
    recommendation, rlAddon,
    t14Kill, t15Active,
    collision: buildCollisionData(away, home),
    pitcherEdge: pitSide ? { name: pitName, era: pitSide.era, fip: pitSide.fip, whip: pitSide.whip } : null,
    odds: { homeML, awayML, homeRL: homeRL?.price, awayRL: awayRL?.price }
  };
}

function buildCollisionData(away, home) {
  const active = away.streak !== home.streak;
  const max = active && (away.streakLen >= 5 || home.streakLen >= 5);
  return {
    active, max,
    away: `${away.streak || '?'}${away.streakLen || 0}`,
    home: `${home.streak || '?'}${home.streakLen || 0}`,
    awayDiff: away.runDiff || 0,
    homeDiff: home.runDiff || 0
  };
}

// ── MAIN SCAN ────────────────────────────────────────────────
async function runMorningScan(apiKey, cfg) {
  if (scanInProgress) return lastScan;
  scanInProgress = true;
  const t0 = Date.now();
  console.log('[Scan] Starting full scan', new Date().toLocaleTimeString());

  try {
    // Step 1: Standings
    console.log('[Scan] Fetching standings...');
    const teams = await fetchStandings();
    console.log(`[Scan] ${Object.keys(teams).length} teams loaded`);

    // Step 2: Schedule
    console.log('[Scan] Fetching schedule...');
    const games = await fetchSchedule();
    console.log(`[Scan] ${games.length} games today`);

    // Step 3: Odds
    console.log('[Scan] Fetching odds...');
    const odds = await fetchOdds(apiKey);
    console.log(`[Scan] ${odds.length} games with odds`);

    // Step 4: For each game — pitcher stats + bullpen
    const gameResults = [];
    for (const game of games) {
      console.log(`[Scan] Analyzing ${game.away.abbr} @ ${game.home.abbr}...`);
      const [awayPit, homePit, awayBP, homeBP] = await Promise.allSettled([
        fetchPitcherStats(game.away.pitcher?.id),
        fetchPitcherStats(game.home.pitcher?.id),
        fetchBullpenStatus(game.away.id),
        fetchBullpenStatus(game.home.id)
      ]);

      const result = runTriggerEngine(
        game, teams, odds,
        awayPit.value || null,
        homePit.value || null,
        awayBP.value || null,
        homeBP.value || null,
        cfg
      );

      gameResults.push({
        game: `${game.away.name} @ ${game.home.name}`,
        gameTime: game.gameTime,
        venue: game.venue,
        away: { ...game.away, ...(teams[game.away.abbr] || {}), pitcherStats: awayPit.value },
        home: { ...game.home, ...(teams[game.home.abbr] || {}), pitcherStats: homePit.value },
        analysis: result
      });
    }

    // Categorize
    const plays = gameResults.filter(g => g.analysis.sizing > 0 && !g.analysis.t14Kill && !g.analysis.t15Active);
    const fades = gameResults.filter(g => g.analysis.t15Active);
    const passes = gameResults.filter(g => g.analysis.gateType && (g.analysis.sizing === 0 || g.analysis.t14Kill));
    const noGate = gameResults.filter(g => !g.analysis.gateType);
    const outliers = Object.values(teams).filter(t => t.regressionFlag);

    // Sort plays by strength
    const strengthOrder = { MAX: 0, STRONG: 1, ENTRY: 2, WATCH: 3 };
    plays.sort((a, b) => (strengthOrder[a.analysis.strength] || 9) - (strengthOrder[b.analysis.strength] || 9));

    lastScan = {
      timestamp: new Date().toISOString(),
      runTime: Date.now() - t0,
      summary: {
        gamesScanned: games.length,
        plays: plays.length,
        fades: fades.length,
        passes: passes.length,
        outliers: outliers.length,
        maxPlays: plays.filter(g => g.analysis.strength === 'MAX').length,
        strongPlays: plays.filter(g => g.analysis.strength === 'STRONG').length
      },
      plays, fades, passes, noGate,
      allGames: gameResults,
      outliers,
      teams
    };

    console.log(`[Scan] Done in ${Date.now() - t0}ms — ${plays.length} plays, ${fades.length} fades`);
    return lastScan;

  } catch(e) {
    console.error('[Scan] Fatal:', e.message);
    return null;
  } finally {
    scanInProgress = false;
  }
}

// ── SCHEDULER ────────────────────────────────────────────────
function scheduleScan(apiKey, cfg) {
  function msUntil9AM() {
    const now = new Date();
    const next = new Date();
    next.setUTCHours(13, 0, 0, 0); // 9AM ET = 13:00 UTC (EDT)
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    return next - now;
  }
  function loop() {
    const ms = msUntil9AM();
    console.log(`[Scan] Next scan in ${Math.round(ms/3600000*10)/10}hrs`);
    setTimeout(async () => { await runMorningScan(apiKey, cfg); loop(); }, ms);
  }
  // Run on boot, then schedule daily
  runMorningScan(apiKey, cfg).then(loop);
}

module.exports = { runMorningScan, getLastScan, scheduleScan };
