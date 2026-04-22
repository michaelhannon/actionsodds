// ============================================================
// ACTION'S ODDS — Morning Scan Module
// Runs at 9AM ET daily via setInterval check
// Exports: runMorningScan(), getLastScan(), scheduleScan()
// ============================================================

const https = require('https');

// ── CONSTANTS ────────────────────────────────────────────────
const MLB_MEAN_ROAD = 0.47;
const MLB_MEAN_HOME = 0.53;
const REGRESSION_THRESHOLD = 0.15; // 15% deviation from mean = flag

// Known regression outliers (updated daily by scan)
const KNOWN_OUTLIERS = {
  SEA: { type: 'road', note: '1 road win — 4% road win%' },
  KC:  { type: 'road', note: '2 road wins — 11% road win%' },
  NYM: { type: 'home', note: '3 home wins — 18% home win%' }
};

// ── CACHE ────────────────────────────────────────────────────
let lastScan = null;
let scanInProgress = false;

function getLastScan() {
  return lastScan;
}

// ── HTTP HELPER ──────────────────────────────────────────────
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'ActionsOdds/1.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('JSON parse error: ' + e.message)); }
      });
    }).on('error', reject);
  });
}

// ── STEP 1: PULL ALL 30 TEAMS ────────────────────────────────
async function fetchStandings() {
  try {
    const url = 'https://statsapi.mlb.com/api/v1/standings?leagueId=103,104&season=2026&standingsTypes=regularSeason&hydrate=team,record,streak,division';
    const data = await fetchJSON(url);
    const teams = {};

    for (const record of (data.records || [])) {
      for (const tr of (record.teamRecords || [])) {
        const abbr = tr.team?.abbreviation || tr.team?.name;
        const wins = tr.wins || 0;
        const losses = tr.losses || 0;
        const total = wins + losses;
        const runsScored = tr.runsScored || 0;
        const runsAllowed = tr.runsAllowed || 0;
        const streak = tr.streak?.streakCode || 'W0';
        const streakType = streak.startsWith('W') ? 'W' : 'L';
        const streakLen = parseInt(streak.slice(1)) || 0;
        const homeWins = tr.records?.splitRecords?.find(s => s.type === 'home')?.wins || 0;
        const homeLosses = tr.records?.splitRecords?.find(s => s.type === 'home')?.losses || 0;
        const roadWins = tr.records?.splitRecords?.find(s => s.type === 'away')?.wins || 0;
        const roadLosses = tr.records?.splitRecords?.find(s => s.type === 'away')?.losses || 0;
        const homeTotal = homeWins + homeLosses;
        const roadTotal = roadWins + roadLosses;
        const homePct = homeTotal > 0 ? homeWins / homeTotal : 0.5;
        const roadPct = roadTotal > 0 ? roadWins / roadTotal : 0.5;
        const runDiff = runsScored - runsAllowed;

        // T4 regression check
        const homeDeviation = Math.abs(homePct - MLB_MEAN_HOME);
        const roadDeviation = Math.abs(roadPct - MLB_MEAN_ROAD);
        let regressionFlag = null;

        if (roadPct < (MLB_MEAN_ROAD - REGRESSION_THRESHOLD) && roadTotal >= 5) {
          regressionFlag = { type: 'road_due', pct: Math.round(roadPct * 100), boost: 'T4 BOOST when road dog' };
        } else if (homePct < (MLB_MEAN_HOME - REGRESSION_THRESHOLD) && homeTotal >= 5) {
          regressionFlag = { type: 'home_due', pct: Math.round(homePct * 100), boost: 'T4 BOOST when home dog' };
        } else if (roadPct > (MLB_MEAN_ROAD + REGRESSION_THRESHOLD) && roadTotal >= 5) {
          regressionFlag = { type: 'road_regress', pct: Math.round(roadPct * 100), boost: 'T4 FADE when road fav' };
        }

        teams[abbr] = {
          name: tr.team?.name || abbr,
          abbr,
          wins, losses, total,
          runDiff,
          streak: streakType, streakLen,
          homeWins, homeLosses, homePct: Math.round(homePct * 100),
          roadWins, roadLosses, roadPct: Math.round(roadPct * 100),
          regressionFlag
        };
      }
    }
    return teams;
  } catch(e) {
    console.error('[MorningScan] Standings fetch error:', e.message);
    return {};
  }
}

// ── STEP 2: FETCH TODAY'S SCHEDULE ───────────────────────────
async function fetchTodaySchedule() {
  try {
    const today = new Date().toISOString().split('T')[0];
    const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${today}&hydrate=probablePitcher(note),team,lineScore`;
    const data = await fetchJSON(url);
    const games = [];

    for (const dateEntry of (data.dates || [])) {
      for (const game of (dateEntry.games || [])) {
        const away = game.teams?.away;
        const home = game.teams?.home;
        const awayAbbr = away?.team?.abbreviation;
        const homeAbbr = home?.team?.abbreviation;
        const awayPitcher = away?.probablePitcher;
        const homePitcher = home?.probablePitcher;
        const gameTime = game.gameDate;
        const venue = game.venue?.name || '';
        const isDome = ['Tropicana Field','Minute Maid Park','Rogers Centre','T-Mobile Park (Dome)','Chase Field'].some(d => venue.includes(d.split('(')[0]));

        games.push({
          gameId: game.gamePk,
          gameTime,
          venue, isDome,
          away: { abbr: awayAbbr, name: away?.team?.name },
          home: { abbr: homeAbbr, name: home?.team?.name },
          awayPitcher: awayPitcher ? {
            name: awayPitcher.fullName,
            id: awayPitcher.id,
            note: awayPitcher.note || ''
          } : null,
          homePitcher: homePitcher ? {
            name: homePitcher.fullName,
            id: homePitcher.id,
            note: homePitcher.note || ''
          } : null
        });
      }
    }
    return games;
  } catch(e) {
    console.error('[MorningScan] Schedule fetch error:', e.message);
    return [];
  }
}

// ── STEP 3: FETCH PITCHER FIP DATA ───────────────────────────
async function fetchPitcherStats(pitcherId) {
  if (!pitcherId) return null;
  try {
    const url = `https://statsapi.mlb.com/api/v1/people/${pitcherId}/stats?stats=season&group=pitching&season=2026`;
    const data = await fetchJSON(url);
    const stats = data.stats?.[0]?.splits?.[0]?.stat;
    if (!stats) return null;
    return {
      era: parseFloat(stats.era) || 0,
      whip: parseFloat(stats.whip) || 0,
      fip: parseFloat(stats.fielding) || null, // FIP not always in basic endpoint
      k9: parseFloat(stats.strikeoutsPer9Inn) || 0,
      bb9: parseFloat(stats.walksPer9Inn) || 0,
      ip: parseFloat(stats.inningsPitched) || 0,
      wins: stats.wins || 0,
      losses: stats.losses || 0
    };
  } catch(e) {
    return null;
  }
}

// ── STEP 4: FETCH LIVE ODDS ───────────────────────────────────
async function fetchOdds(apiKey) {
  if (!apiKey) return [];
  try {
    const url = `https://api.the-odds-api.com/v4/sports/baseball_mlb/odds/?apiKey=${apiKey}&regions=us&markets=h2h,spreads&oddsFormat=american&bookmakers=draftkings,fanduel,betmgm,caesars`;
    const data = await fetchJSON(url);
    return data || [];
  } catch(e) {
    console.error('[MorningScan] Odds fetch error:', e.message);
    return [];
  }
}

// ── STEP 5: COLLISION + TRIGGER ANALYSIS ─────────────────────
function analyzeCollisions(games, teams, oddsData, cfg) {
  const t1Min = cfg.t1Min || 140;
  const t1Max = cfg.t1Max || 199;
  const t11Min = cfg.t11Min || 115;
  const t11Max = cfg.t11Max || 135;
  const t12Min = cfg.t12Min || 110;

  const results = [];

  for (const game of games) {
    const awayTeam = teams[game.away.abbr] || {};
    const homeTeam = teams[game.home.abbr] || {};

    // T2: Collision check
    const awayStreak = awayTeam.streak || 'W';
    const awayStreakLen = awayTeam.streakLen || 0;
    const homeStreak = homeTeam.streak || 'W';
    const homeStreakLen = homeTeam.streakLen || 0;

    const collisionActive = (awayStreak !== homeStreak); // W vs L on opposite sides
    const maxCollision = (awayStreakLen >= 5 || homeStreakLen >= 5) && collisionActive;
    const fadeZone = awayStreakLen >= 9 || homeStreakLen >= 9;

    // T3: Run differential gap
    const awayDiff = awayTeam.runDiff || 0;
    const homeDiff = homeTeam.runDiff || 0;
    const diffGap = Math.abs(awayDiff - homeDiff);
    const t3Fires = diffGap >= 20; // 20+ run gap = meaningful T3

    // Which side benefits from collision
    let collisionFavors = null;
    if (collisionActive) {
      // Home team on W streak vs away on L streak = favor home (but they're likely fav, check gate)
      // Home team on L streak vs away on W streak = collision favors away dog situation
      if (homeStreak === 'L' && awayStreak === 'W') {
        collisionFavors = 'away';
      } else if (homeStreak === 'W' && awayStreak === 'L') {
        collisionFavors = 'home';
      }
    }

    // T4: Regression flags for this game
    const awayRegFlag = awayTeam.regressionFlag;
    const homeRegFlag = homeTeam.regressionFlag;

    // Get odds for this game
    const gameOdds = oddsData.find(o =>
      (o.home_team?.includes(game.home.abbr) || o.home_team === game.home.name) ||
      (o.away_team?.includes(game.away.abbr) || o.away_team === game.away.name)
    );

    let homeML = null, awayML = null;
    if (gameOdds) {
      const bm = gameOdds.bookmakers?.[0];
      const h2h = bm?.markets?.find(m => m.key === 'h2h');
      homeML = h2h?.outcomes?.find(o => o.name === gameOdds.home_team)?.price;
      awayML = h2h?.outcomes?.find(o => o.name === gameOdds.away_team)?.price;
    }

    // Gate check
    let gateStatus = 'NO_GATE';
    let gateLabel = '—';
    let playRecommendation = null;

    if (homeML !== null) {
      if (homeML >= t1Min && homeML <= t1Max) {
        gateStatus = 'T1';
        gateLabel = `T1 +${homeML}`;
        // Count triggers
        let trigCount = 1; // T1 itself
        if (collisionActive && collisionFavors === 'home') trigCount++;
        if (t3Fires && homeDiff > awayDiff) trigCount++;
        if (homeRegFlag?.type === 'home_due') trigCount++;
        const sizing = trigCount >= 4 ? 1000 : trigCount === 3 ? 800 : trigCount === 2 ? 600 : trigCount === 1 ? 400 : 200;
        playRecommendation = {
          side: 'home', team: game.home.name, ml: homeML,
          trigCount, sizing,
          strength: trigCount >= 4 ? 'MAX' : trigCount === 3 ? 'STRONG' : trigCount === 2 ? 'ENTRY' : 'WATCH',
          color: trigCount >= 4 ? 'blue' : trigCount === 3 ? 'green' : trigCount === 2 ? 'teal' : 'amber'
        };
      } else if (homeML < 0 && Math.abs(homeML) >= t11Min && Math.abs(homeML) <= t11Max) {
        gateStatus = 'T11';
        gateLabel = `T11 ${homeML}`;
      } else if (homeML >= t12Min && homeML < t1Min) {
        gateStatus = 'T12';
        gateLabel = `T12 +${homeML}`;
      }
    }

    // T13: Road dog
    if (awayML !== null && awayML >= 120 && gateStatus === 'NO_GATE') {
      gateStatus = 'T13';
      gateLabel = `T13 +${awayML}`;
    }

    results.push({
      game: `${game.away.name} @ ${game.home.name}`,
      gameTime: game.gameTime,
      venue: game.venue,
      isDome: game.isDome,
      away: {
        abbr: game.away.abbr,
        name: game.away.name,
        streak: awayStreak,
        streakLen: awayStreakLen,
        runDiff: awayDiff,
        record: `${awayTeam.wins||0}-${awayTeam.losses||0}`,
        regressionFlag: awayRegFlag
      },
      home: {
        abbr: game.home.abbr,
        name: game.home.name,
        streak: homeStreak,
        streakLen: homeStreakLen,
        runDiff: homeDiff,
        record: `${homeTeam.wins||0}-${homeTeam.losses||0}`,
        regressionFlag: homeRegFlag
      },
      collision: {
        active: collisionActive,
        max: maxCollision,
        fadeZone,
        favors: collisionFavors,
        awayStreakStr: `${awayStreak}${awayStreakLen}`,
        homeStreakStr: `${homeStreak}${homeStreakLen}`
      },
      t3: { fires: t3Fires, gap: diffGap },
      odds: { homeML, awayML },
      gate: { status: gateStatus, label: gateLabel },
      playRecommendation,
      awayPitcher: game.awayPitcher,
      homePitcher: game.homePitcher
    });
  }

  return results;
}

// ── MAIN SCAN FUNCTION ───────────────────────────────────────
async function runMorningScan(apiKey, cfg) {
  if (scanInProgress) {
    console.log('[MorningScan] Scan already in progress, skipping');
    return lastScan;
  }

  scanInProgress = true;
  const startTime = Date.now();
  console.log('[MorningScan] Starting morning scan at', new Date().toLocaleTimeString());

  try {
    // Step 1: All 30 teams
    console.log('[MorningScan] Step 1 — Fetching standings...');
    const teams = await fetchStandings();
    const teamCount = Object.keys(teams).length;
    console.log(`[MorningScan] Got ${teamCount} teams`);

    // Step 2: Today's schedule
    console.log('[MorningScan] Step 2 — Fetching schedule...');
    const games = await fetchTodaySchedule();
    console.log(`[MorningScan] Got ${games.length} games today`);

    // Step 3: Live odds
    console.log('[MorningScan] Step 3 — Fetching odds...');
    const oddsData = await fetchOdds(apiKey);
    console.log(`[MorningScan] Got ${oddsData.length} games with odds`);

    // Step 4: Collision + trigger analysis
    console.log('[MorningScan] Step 4 — Running collision + trigger analysis...');
    const analysis = analyzeCollisions(games, teams, oddsData, cfg || {});

    // Categorize results
    const qualifying = analysis.filter(g => g.gate.status !== 'NO_GATE');
    const collisions = analysis.filter(g => g.collision.active);
    const maxCollisions = analysis.filter(g => g.collision.max);
    const regressionFlags = analysis.filter(g => g.away.regressionFlag || g.home.regressionFlag);
    const plays = analysis.filter(g => g.playRecommendation);
    const fades = analysis.filter(g =>
      (g.away.streak === 'L' && g.away.streakLen >= 5 && g.away.runDiff < 0) ||
      (g.home.streak === 'L' && g.home.streakLen >= 5 && g.home.runDiff < 0)
    );

    // Build regression outlier list from live data
    const outliers = [];
    for (const [abbr, team] of Object.entries(teams)) {
      if (team.regressionFlag) {
        outliers.push({ abbr, ...team });
      }
    }

    lastScan = {
      timestamp: new Date().toISOString(),
      runTime: Date.now() - startTime,
      summary: {
        teamsScanned: teamCount,
        gamesFound: games.length,
        qualifying: qualifying.length,
        collisions: collisions.length,
        maxCollisions: maxCollisions.length,
        plays: plays.length,
        fades: fades.length,
        regressionFlags: regressionFlags.length
      },
      games: analysis,
      qualifying,
      plays,
      fades,
      collisions,
      maxCollisions,
      outliers,
      teams // full team data for grid
    };

    console.log(`[MorningScan] Complete in ${Date.now() - startTime}ms — ${plays.length} plays, ${collisions.length} collisions, ${outliers.length} regression flags`);
    return lastScan;

  } catch(e) {
    console.error('[MorningScan] Fatal error:', e.message);
    return null;
  } finally {
    scanInProgress = false;
  }
}

// ── SCHEDULER ────────────────────────────────────────────────
function scheduleScan(apiKey, cfg) {
  function msUntilNext9AM() {
    const now = new Date();
    const target = new Date();
    // 9AM Eastern = 14:00 UTC (EST) or 13:00 UTC (EDT)
    // Use 13:00 UTC to approximate EDT
    target.setUTCHours(13, 0, 0, 0);
    if (target <= now) target.setUTCDate(target.getUTCDate() + 1);
    return target - now;
  }

  function scheduleNext() {
    const ms = msUntilNext9AM();
    const hrs = Math.round(ms / 1000 / 60 / 60 * 10) / 10;
    console.log(`[MorningScan] Next scan scheduled in ${hrs} hours`);
    setTimeout(async () => {
      await runMorningScan(apiKey, cfg);
      scheduleNext(); // reschedule for next day
    }, ms);
  }

  // Run immediately on startup if no scan yet
  console.log('[MorningScan] Scheduler started — running initial scan...');
  runMorningScan(apiKey, cfg).then(() => {
    scheduleNext();
  });
}

module.exports = { runMorningScan, getLastScan, scheduleScan };
