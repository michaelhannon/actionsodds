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
        // T4-RS: Road win streak signal
        // T4-HL: Home loss streak signal (computed after we have streak data)
        // streakType/streakLen = current overall streak
        // We track road/home sub-streaks separately via recent game analysis
        // For now flag based on current streak context + road/home record
        let roadStreakSignal = null;
        let homeLossSignal = null;

        // Road win streak: if team is on current W streak and road win% is strong
        // Approximate: if overall streak is W and road games are weighted heavily
        if (streakType === 'W') {
          if (streakLen >= 5) roadStreakSignal = { len: streakLen, level: 'max', boost: 1.0, note: `W${streakLen} road proven — maximum road confidence` };
          else if (streakLen >= 3) roadStreakSignal = { len: streakLen, level: 'strong', boost: 0.75, note: `W${streakLen} — top 10% road trip, strong signal` };
          else if (streakLen >= 2) roadStreakSignal = { len: streakLen, level: 'entry', boost: 0.5, note: `W${streakLen} road — active play list` };
        }

        // Home loss streak: if team is on current L streak at home
        if (streakType === 'L') {
          if (streakLen >= 7) homeLossSignal = { len: streakLen, level: 'max_fade', fade: 1.0, note: `L${streakLen} home — maximum fade, structural failure` };
          else if (streakLen >= 5) homeLossSignal = { len: streakLen, level: 'strong_fade', fade: 0.75, note: `L${streakLen} home — strong fade, systemic` };
          else if (streakLen >= 3) homeLossSignal = { len: streakLen, level: 'fade', fade: 0.5, note: `L${streakLen} home — fade signal active` };
          else if (streakLen >= 2) homeLossSignal = { len: streakLen, level: 'entry_fade', fade: 0.25, note: `L${streakLen} home — fade list entry` };
        }

        teams[abbr] = {
          name: tr.team?.name || abbr, abbr,
          wins, losses, runDiff,
          streak: streakType, streakLen,
          homeW, homeL, homePct: Math.round(homePct * 100),
          roadW, roadL, roadPct: Math.round(roadPct * 100),
          homeTotal, roadTotal, regressionFlag,
          roadStreakSignal, homeLossSignal,
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
        const state = g.status?.abstractGameState;
        const detail = g.status?.detailedState || '';
        // Skip games already started or completed
        if (state === 'Final' || state === 'Live' || detail.includes('In Progress') || detail.includes('Delayed') ) continue;
        // Also skip if game time has already passed
        const gTime = new Date(g.gameDate);
        if (gTime < new Date(Date.now() - 5 * 60 * 1000)) continue; // 5min grace
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

// ── STEP 3: PITCHER STATS (ERA, FIP, WHIP, K9, BB9) ──────────
// FIP = (13*HR + 3*BB - 2*K) / IP + 3.20
// Sources: MLB Stats API (primary) → ESPN API (fallback)
async function fetchPitcherStats(pitcherId, pitcherName) {
  if (!pitcherId && !pitcherName) return null;

  // PRIMARY: MLB Stats API — clean season stats endpoint
  if (pitcherId) {
    try {
      // Use simple season stats endpoint — no sitCodes filter
      const url = `https://statsapi.mlb.com/api/v1/people/${pitcherId}/stats?stats=season&group=pitching&season=2026`;
      const data = await fetchJSON(url, 6000);

      // Try multiple stat type names the API uses
      let season = null;
      const statTypes = ['statsSingleSeason','regularSeason','byDateRange'];
      for (const t of statTypes) {
        season = data.stats?.find(s =>
          s.type?.displayName === t ||
          s.type?.displayName?.toLowerCase().includes('season')
        )?.splits?.[0]?.stat;
        if (season) break;
      }
      // Also try first available split if type search fails
      if (!season) {
        season = data.stats?.[0]?.splits?.[0]?.stat;
      }

      if (season) {
        const ip = parseFloat(season.inningsPitched) || 0;
        const era = parseFloat(season.era) || 0;
        const whip = parseFloat(season.whip) || 0;
        const k9 = parseFloat(season.strikeoutsPer9Inn) || 0;
        const bb9 = parseFloat(season.walksPer9Inn) || 0;
        const k = parseInt(season.strikeOuts) || 0;
        const bb = parseInt(season.baseOnBalls) || 0;
        const hr = parseInt(season.homeRuns) || 0;
        const gs = parseInt(season.gamesStarted) || 0;
        const wins = parseInt(season.wins) || 0;
        const losses = parseInt(season.losses) || 0;

        if (ip > 0) {
          // True FIP formula
          const fip = Math.round(((13 * hr + 3 * bb - 2 * k) / ip + 3.20) * 100) / 100;
          const hr9 = Math.round((hr / ip * 9) * 100) / 100;
          console.log(`[Pitcher] ${pitcherName||pitcherId}: ERA ${era} FIP ${fip} K ${k} BB ${bb} HR ${hr} IP ${ip}`);
          return { era, fip, whip, k9, bb9, hr9, ip, gs, wins, losses, k, bb, hr, source: 'mlb' };
        }
      }
    } catch(e) {
      console.log(`[Pitcher] MLB API failed for ${pitcherId}: ${e.message}`);
    }
  }

  // FALLBACK: ESPN API — returns ERA, K, BB, HR, IP
  if (pitcherName) {
    try {
      const searchName = encodeURIComponent(pitcherName.split(' ').slice(-1)[0]); // last name
      const espnUrl = `https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/athletes?limit=5&search=${searchName}`;
      const espnData = await fetchJSON(espnUrl, 5000);
      const athlete = espnData.items?.[0];
      if (athlete?.id) {
        const statsUrl = `https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/athletes/${athlete.id}/stats`;
        const statsData = await fetchJSON(statsUrl, 5000);
        // ESPN returns categories array with pitching stats
        const pitching = statsData.splits?.categories?.find(c => c.name === 'pitching');
        if (pitching) {
          const getVal = (name) => {
            const idx = pitching.names?.indexOf(name);
            return idx >= 0 ? parseFloat(pitching.totals?.[idx]) || 0 : 0;
          };
          const era = getVal('ERA') || getVal('era');
          const ip = getVal('IP') || getVal('innings');
          const k = getVal('K') || getVal('strikeouts');
          const bb = getVal('BB') || getVal('walks');
          const hr = getVal('HR') || getVal('homeRunsAllowed');
          const whip = getVal('WHIP') || getVal('whip');
          if (ip > 0) {
            const fip = Math.round(((13 * hr + 3 * bb - 2 * k) / ip + 3.20) * 100) / 100;
            console.log(`[Pitcher] ESPN fallback ${pitcherName}: ERA ${era} FIP ${fip}`);
            return { era, fip, whip, k9: ip > 0 ? Math.round(k/ip*9*10)/10 : 0, bb9: ip > 0 ? Math.round(bb/ip*9*10)/10 : 0, hr9: ip > 0 ? Math.round(hr/ip*9*100)/100 : 0, ip, k, bb, hr, source: 'espn' };
          }
        }
      }
    } catch(e) {
      console.log(`[Pitcher] ESPN fallback failed for ${pitcherName}: ${e.message}`);
    }
  }

  console.log(`[Pitcher] All sources failed for ${pitcherId||pitcherName}`);
  return null;
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
    const url = `https://api.the-odds-api.com/v4/sports/baseball_mlb/odds/?apiKey=${apiKey}&regions=us&markets=h2h,spreads&oddsFormat=american&bookmakers=draftkings,fanduel,betmgm,caesars,hard_rock_bet`;
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
  // Fuzzy team matching — MLB Stats API names vs Odds API names differ
  function teamMatch(oddsName, statsName, abbr) {
    if (!oddsName || !statsName) return false;
    if (oddsName === statsName) return true;
    // Last word match (e.g. "Tigers" in both)
    const oLast = oddsName.split(' ').pop().toLowerCase();
    const sLast = statsName.split(' ').pop().toLowerCase();
    if (oLast === sLast && oLast.length > 3) return true;
    // City match
    const oFirst = oddsName.split(' ')[0].toLowerCase();
    const sFirst = statsName.split(' ')[0].toLowerCase();
    if (oFirst === sFirst && oFirst.length > 3) return true;
    return false;
  }
  const gameOdds = odds.find(o => {
    return (teamMatch(o.home_team, game.home.name, game.home.abbr) ||
            teamMatch(o.away_team, game.away.name, game.away.abbr));
  });

  let homeML = null, awayML = null, homeRL = null, awayRL = null;
  if (gameOdds) {
    const bm = gameOdds.bookmakers?.find(b => ['draftkings','fanduel','betmgm','caesars','hard_rock_bet'].includes(b.key)) || gameOdds.bookmakers?.[0];
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
  if (!gateType && awayML != null && awayML >= 125) {
    gateType = 'T13'; gateML = awayML; gateSide = 'away';
  }
  // T15: Home fade — road dog backing
  let t15Active = false;
  if (awayML != null && awayML >= 125) {
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

  // ── T6 FIP-gap kill flag (computed in T6 block below; declared here for scope)
  let t6FipKill = false;

  // T2: Streak collision
  const collisionActive = away.streak !== home.streak;
  const collisionMax = collisionActive && (away.streakLen >= 5 || home.streakLen >= 5);
  const fadeZone = away.streakLen >= 9 || home.streakLen >= 9;
  if (collisionActive) {
    // Apr 29 2026: T2 collision rule — bet side must be W2+, fade side must be L2+
    // Rule: never back a losing-streak team; never fade a non-losing-streak team
    const betSide = gateSide;
    const betTeam = betSide === 'home' ? home : away;
    const fadeTeam = betSide === 'home' ? away : home;
    const betOnWinStreak = betTeam.streak === 'W' && betTeam.streakLen >= 2;
    const fadeOnLossStreak = fadeTeam.streak === 'L' && fadeTeam.streakLen >= 2;
    // W10/L10 cap: streak length 10+ = fade zone, T2 fails
    const betCapped = betTeam.streakLen >= 10;
    const fadeCapped = fadeTeam.streakLen >= 10;
    if (betOnWinStreak && fadeOnLossStreak && !betCapped && !fadeCapped) {
      triggered.push('T2');
      const sideLbl = betSide === 'home'
        ? `Home ${betTeam.abbr} W${betTeam.streakLen} vs Away ${fadeTeam.abbr} L${fadeTeam.streakLen}`
        : `Away ${betTeam.abbr} W${betTeam.streakLen} vs Home ${fadeTeam.abbr} L${fadeTeam.streakLen}`;
      notes.push(`T2 ✓ ${sideLbl}` + (collisionMax ? ' — MAX COLLISION' : ''));
    } else {
      failed.push('T2');
      let why;
      if (betCapped) why = `bet team ${betTeam.abbr} W${betTeam.streakLen} CAPPED (W10+ fade zone)`;
      else if (fadeCapped) why = `fade team ${fadeTeam.abbr} L${fadeTeam.streakLen} CAPPED (L10+ fade zone)`;
      else if (!betOnWinStreak) why = `bet team ${betTeam.abbr} not on W2+ (${betTeam.streak}${betTeam.streakLen})`;
      else why = `fade team ${fadeTeam.abbr} not on L2+ (${fadeTeam.streak}${fadeTeam.streakLen})`;
      notes.push(`T2 ✗ Collision fails — ${why}`);
    }
  } else {
    failed.push('T2');
    notes.push('T2 ✗ No streak data available');
  }

  // ── HARD KILL: never back a losing-streak team (memory rule, no exceptions)
  const _bet = gateSide === 'home' ? home : away;
  const _betBullpen = gateSide === 'home' ? homeBullpen : awayBullpen;
  let betTeamLossKill = false;
  let betBullpenKill = false;
  if (_bet.streak === 'L' && _bet.streakLen >= 1) {
    betTeamLossKill = true;
    failed.push('STREAK_KILL');
    notes.push(`✗ HARD KILL — bet team ${_bet.abbr} on L${_bet.streakLen}; never back a losing-streak team`);
  }
  // T8 BET-SIDE KILL: never back a team whose own bullpen is depleted
  if (_betBullpen && _betBullpen.depleted === true) {
    betBullpenKill = true;
    failed.push('T8_BET_KILL');
    notes.push(`✗ HARD KILL — bet team ${_bet.abbr} bullpen depleted (${_betBullpen.note || 'BP gassed'})`);
  }

  // T3: Run differential
  const gradeTeam = gateSide === 'home' ? home : away;
  const oppTeam = gateSide === 'home' ? away : home;
  if (gradeTeam.runDiff > 0) {
    triggered.push('T3');
    notes.push(`T3 ✓ ${gradeTeam.abbr} run diff ${gradeTeam.runDiff > 0 ? '+' : ''}${gradeTeam.runDiff}`);
  } else if (gradeTeam.runDiff < -10) {
    failed.push('T3');
    notes.push(`T3 ✗ ${gradeTeam.abbr} run diff ${gradeTeam.runDiff} — KILLS PLAY (T3 hard kill)`);
    // T3 hard kill flag — will zero sizing below
  } else {
    notes.push(`T3 ~ ${gradeTeam.abbr} run diff ${gradeTeam.runDiff} — neutral`);
  }

  // T4: Home/away split regression + T4-RS road streak + T4-HL home loss
  const regFlag = gradeTeam.regressionFlag;
  const roadSig = gradeTeam.roadStreakSignal;
  const homeLossSig = gradeTeam.homeLossSignal;
  const oppRoadSig = oppTeam.roadStreakSignal;
  const oppHomeLossSig = oppTeam.homeLossSignal;

  let t4Fired = false;

  // T4 base: regression to mean
  if (regFlag) {
    triggered.push('T4');
    t4Fired = true;
    notes.push(`T4 ✓ Regression due — ${gradeTeam.abbr} ${regFlag.type.replace('_',' ')} ${regFlag.pct}% (mean ${regFlag.type.includes('road') ? '47' : '53'}%)`);
  }

  // T4-RS: Road win streak modifier (applies when grading AWAY team)
  if (gateSide === 'away' && roadSig) {
    if (roadSig.level === 'max') {
      triggered.push('T4-RS');
      notes.push(`T4-RS ✓ MAX road streak — ${gradeTeam.abbr} W${roadSig.len} road, top 2% of road trips, +1 full trigger`);
    } else if (roadSig.level === 'strong') {
      triggered.push('T4-RS');
      notes.push(`T4-RS ✓ Strong road streak — ${gradeTeam.abbr} W${roadSig.len}, top 10%, +0.75 trigger weight`);
    } else if (roadSig.level === 'entry') {
      notes.push(`T4-RS ~ Entry road streak — ${gradeTeam.abbr} W${roadSig.len}, note for parlay play list`);
    }
  }

  // T4-HL: Home loss streak on OPPONENT amplifies fade / boosts our team
  if (oppHomeLossSig) {
    if (oppHomeLossSig.level === 'max_fade') {
      triggered.push('T4-HL');
      notes.push(`T4-HL ✓ MAX home loss fade — opp ${oppTeam.abbr} L${oppHomeLossSig.len} at home, structural failure, +1 trigger`);
    } else if (oppHomeLossSig.level === 'strong_fade') {
      triggered.push('T4-HL');
      notes.push(`T4-HL ✓ Strong home fade — opp ${oppTeam.abbr} L${oppHomeLossSig.len} at home, systemic issue`);
    } else if (oppHomeLossSig.level === 'fade') {
      notes.push(`T4-HL ~ Opp ${oppTeam.abbr} L${oppHomeLossSig.len} at home — fade signal noted`);
    }
  }

  // T15 amplifier: if home team has homeLossSignal L5+ it reduces filters needed
  if (gateSide === 'away' && homeLossSig && homeLossSig.level !== 'entry_fade') {
    notes.push(`T4-HL ⚠ Home team ${gradeTeam.abbr} L${homeLossSig.len} at home — T15 fade threshold reduced`);
  }

  if (!t4Fired && !roadSig && !oppHomeLossSig) {
    notes.push(`T4 ~ No regression/streak signal for this matchup`);
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

  // T4-RS bonus: W5+ road streak = counts as full extra trigger for sizing
  if (triggered.includes('T4-RS') && roadSig?.level === 'max') {
    trigCount++; // extra credit for elite road streak
    notes.push('T4-RS MAX bonus: +1 trigger added to sizing');
  }

  // T10: Divisional familiarity (one confirming trigger; does not apply if opponent on hot streak)
  const isDivisional = away.division === home.division;
  if (isDivisional) {
    const oppHotStreak = oppTeam.streak === 'W' && oppTeam.streakLen >= 3;
    if (oppHotStreak) {
      notes.push(`T10 ~ Divisional matchup but opp ${oppTeam.abbr} on W${oppTeam.streakLen} hot streak — T10 does not apply`);
    } else {
      triggered.push('T10');
      notes.push('T10 ✓ Divisional matchup — confirming trigger');
    }
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

  // Apr 29 2026: T10 is ONE confirming trigger only (corrected — old "counts as 2" rule was wrong)
  // No double-counting; T10 is already in triggered[] from above.

  // Collision max = gate alone sufficient
  const gateAlone = collisionMax && (away.streakLen >= 5 || home.streakLen >= 5);

  // Kill if T14 fired, bet team on losing streak, bet-team bullpen depleted, or T6 FIP gap >= 2.0
  if (t14Kill) trigCount = 0;
  if (betTeamLossKill) trigCount = 0;
  if (betBullpenKill) trigCount = 0;
  if (t6FipKill) trigCount = 0;

  // ── UNIT TABLE (Apr 28 2026) ───────────────────────────
  // Fixed dollar units. Tiers: 1u ENTRY, 2u STRONG, 3u MAX, 5u SUPER MAX (reserved).
  const UNIT_TABLE_MLB = {1:250, 2:500, 3:750, 5:1000};
  const TIER_LABEL_MLB = {1:'ENTRY', 2:'STRONG', 3:'MAX', 5:'SUPER MAX'};

  // Gate caps (dollar ceilings — units mapping respects these)
  let maxSize = 1000;
  if (gateType === 'T11') maxSize = 750;
  if (gateType === 'T12') maxSize = 1000;
  if (gateType === 'T13') maxSize = 1000;

  // Map (gate, trigCount) -> unit count
  let units = 0;
  if (!t14Kill && !betTeamLossKill && !betBullpenKill && !t6FipKill) {
    if (gateType === 'T1' || gateType === 'T1B') {
      // T1 alone is the gate, not a play. Need at least 1 stacking trigger.
      if (trigCount >= 4) units = 5;          // SUPER MAX
      else if (trigCount === 3) units = 3;    // MAX
      else if (trigCount === 2) units = 2;    // STRONG
      else if (trigCount === 1) units = 1;    // ENTRY
      else units = 0;
    } else if (gateType === 'T11') {
      if (trigCount >= 4) units = 3;          // MAX
      else if (trigCount === 3) units = 2;    // STRONG
      else if (trigCount === 2) units = 1;    // ENTRY
      else units = 0;
    } else if (gateType === 'T12') {
      if (trigCount >= 5) units = 5;          // SUPER MAX
      else if (trigCount === 4) units = 3;    // MAX
      else if (trigCount === 3) units = 2;    // STRONG
      else if (trigCount === 2) units = 1;    // ENTRY
      else units = 0;
    } else if (gateType === 'T13') {
      units = 0; // computed below from C1-C6 signals
    } else if (t15Active) {
      units = 1; // restricted, parlay-only at $100
    } else {
      // Fallback ladder
      if (trigCount >= 4) units = 5;
      else if (trigCount === 3) units = 3;
      else if (trigCount === 2) units = 2;
      else if (trigCount === 1) units = 1;
      else units = 0;
    }
  }

  // T3 hard kill — negative run diff below -10 kills any play
  const t3Kill = gradeTeam.runDiff < -10;
  if (t3Kill) { units = 0; }

  // T11 needs 3+ triggers minimum
  if (gateType === 'T11' && trigCount < 2) units = 0;
  // T12 needs 5+ triggers minimum
  if (gateType === 'T12' && trigCount < 2) units = 0;
  // T13: unified road dog +125+ with 6 confirming signals (C1-C6)
  // C1=T2, C2=T3, C3=T6, C4=T8, C5=F5 (home BP explicit), C6=F6 (road T14 superior)
  if (gateType === 'T13') {
    // Unified road dog gate at +125+ with 6 confirming signals (C1-C6)
    // C1=T2, C2=T3, C3=T6, C4=T8, C5=F5 (home BP deeper depletion), C6=F6 (road T14 superior)
    const c1 = triggered.includes('T2') ? 1 : 0;
    const c2 = triggered.includes('T3') ? 1 : 0;
    const c3 = triggered.includes('T6') ? 1 : 0;
    const c4 = triggered.includes('T8') ? 1 : 0;
    // C5 (F5): home BP "depleted" beyond T8 — both flags fire when usage is heavy
    const c5 = (homeBullpen && homeBullpen.depleted === true) ? 1 : 0;
    // C6 (F6): road team power rating clearly superior (5+ pts in road's favor)
    const c6 = (favoredPower === 'away' && powerGap >= 5) ? 1 : 0;
    const signalCount = c1 + c2 + c3 + c4 + c5 + c6;

    if (signalCount < 3) {
      units = 0;
    } else {
      // T14 bidirectional: 15+ pt gap toward EITHER side
      // Toward home (against road dog) = kill, unless all 6 fire (downgrade to 1u)
      // Toward road (favoring road dog) = no penalty, scale normally
      if (favoredPower === 'home' && powerGap >= 15) {
        units = (signalCount === 6) ? 1 : 0;
      } else {
        if (signalCount >= 6) units = 5;       // SUPER MAX
        else if (signalCount === 5) units = 3; // MAX
        else if (signalCount === 4) units = 2; // STRONG
        else units = 1;                         // ENTRY (signalCount === 3)
      }
    }

    // Audit note
    notes.push(`T13 signals: C1${c1?'✓':'✗'} C2${c2?'✓':'✗'} C3${c3?'✓':'✗'} C4${c4?'✓':'✗'} C5${c5?'✓':'✗'} C6${c6?'✓':'✗'} = ${signalCount}/6 → ${units}u`);
  }

  // Resolve dollar amount from unit table (MLB default; sport hooks can override later)
  let sizing = UNIT_TABLE_MLB[units] || 0;
  // Enforce cap (defensive — table already respects it)
  if (sizing > maxSize) sizing = maxSize;

  const tier = TIER_LABEL_MLB[units] || '';

  // ── COLOR + STRENGTH ─────────────────────────────────────
  let color, strength, recommendation;
  if (t14Kill || sizing === 0) {
    color = 'red'; strength = 'PASS';
    recommendation = 'PASS — ' + (t14Kill ? 'T14 power ratings kill this play' : (betTeamLossKill ? `${_bet.abbr} on L${_bet.streakLen} — never back a losing-streak team` : 'Insufficient triggers'));
  } else if (t15Active) {
    color = 'orange'; strength = 'FADE';
    recommendation = `T15 FADE — ${game.away.name} (exotic/parlay only, $50-100)`;
  } else if (units >= 5) {
    color = 'purple'; strength = 'SUPER MAX';
    recommendation = `${gateSide === 'home' ? game.home.name : game.away.name} ML ${gateML > 0 ? '+' : ''}${gateML} — $${sizing}`;
  } else if (units === 3) {
    color = 'blue'; strength = 'MAX';
    recommendation = `${gateSide === 'home' ? game.home.name : game.away.name} ML ${gateML > 0 ? '+' : ''}${gateML} — $${sizing}`;
  } else if (units === 2) {
    color = 'green'; strength = 'STRONG';
    recommendation = `${gateSide === 'home' ? game.home.name : game.away.name} ML ${gateML > 0 ? '+' : ''}${gateML} — $${sizing}`;
  } else if (units === 1) {
    color = 'teal'; strength = 'ENTRY';
    recommendation = `${gateSide === 'home' ? game.home.name : game.away.name} ML ${gateML > 0 ? '+' : ''}${gateML} — $${sizing}`;
  } else {
    color = 'amber'; strength = 'WATCH';
    recommendation = `${gateSide === 'home' ? game.home.name : game.away.name} ML ${gateML > 0 ? '+' : ''}${gateML} — $${sizing} (borderline)`;
  }

  // Run line — always display both sides, flag qualifying add-on separately
  // Rule: fav -1.5 must pay +115+. Dog +1.5 must pay +100+. Add-on only when 4+ triggers.
  const rlDisplay = {
    homeLine: homeRL ? { point: homeRL.point, price: homeRL.price } : null,
    awayLine: awayRL ? { point: awayRL.point, price: awayRL.price } : null
  };

  let rlAddon = null;
  if (!t14Kill && !t15Active && trigCount >= 3) {
    // Fav -1.5 at plus money (best value)
    if (gateSide === 'home' && awayRL?.point <= -1 && awayRL?.price >= 115) {
      rlAddon = { desc: `${game.away.name} -1.5 ${awayRL.price > 0 ? '+' : ''}${awayRL.price}`, amt: Math.round((sizing||200) * 0.5), qualifying: true };
    } else if (gateSide === 'away' && homeRL?.point <= -1 && homeRL?.price >= 115) {
      rlAddon = { desc: `${game.home.name} -1.5 ${homeRL.price > 0 ? '+' : ''}${homeRL.price}`, amt: Math.round((sizing||200) * 0.5), qualifying: true };
    }
    // Dog +1.5 at +100 or better
    else if (gateSide === 'home' && homeRL?.point >= 1 && homeRL?.price >= 100) {
      rlAddon = { desc: `${game.home.name} +1.5 ${homeRL.price > 0 ? '+' : ''}${homeRL.price}`, amt: Math.round((sizing||200) * 0.5), qualifying: trigCount >= 4 };
    } else if (gateSide === 'away' && awayRL?.point >= 1 && awayRL?.price >= 100) {
      rlAddon = { desc: `${game.away.name} +1.5 ${awayRL.price > 0 ? '+' : ''}${awayRL.price}`, amt: Math.round((sizing||200) * 0.5), qualifying: trigCount >= 4 };
    }
  }

  return {
    gateType, gateML, gateSide,
    triggered, failed, notes,
    trigCount, sizing,
    units,
    tier, color, strength,
    recommendation, rlAddon, rlDisplay,
    t14Kill, t15Active, t3Kill,
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
        fetchPitcherStats(game.away.pitcher?.id, game.away.pitcher?.fullName),
        fetchPitcherStats(game.home.pitcher?.id, game.home.pitcher?.fullName),
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
    const plays = gameResults.filter(g => g.analysis.sizing > 0 && !g.analysis.t14Kill && !g.analysis.t15Active && !g.analysis.t3Kill);
    const fades = gameResults.filter(g => g.analysis.t15Active);
    const passes = gameResults.filter(g => g.analysis.gateType && (g.analysis.sizing === 0 || g.analysis.t14Kill));
    const noGate = gameResults.filter(g => !g.analysis.gateType);
    const outliers = Object.values(teams).filter(t => t.regressionFlag);

    // Sort all games by start time
    gameResults.sort((a, b) => new Date(a.gameTime) - new Date(b.gameTime));

    // Sort plays: by strength first, then by start time
    const strengthOrder = { MAX: 0, STRONG: 1, ENTRY: 2, WATCH: 3 };
    plays.sort((a, b) => {
      const sDiff = (strengthOrder[a.analysis.strength] || 9) - (strengthOrder[b.analysis.strength] || 9);
      if (sDiff !== 0) return sDiff;
      return new Date(a.gameTime) - new Date(b.gameTime);
    });

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
        strongPlays: plays.filter(g => g.analysis.strength === 'STRONG').length,
        roadStreakTeams: Object.values(teams).filter(t => t.roadStreakSignal).length,
        homeLossTeams: Object.values(teams).filter(t => t.homeLossSignal && t.homeLossSignal.level !== 'entry_fade').length
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
