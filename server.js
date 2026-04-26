// =============================================================================
// Action's Odds — server.js (Express)
//
// Migrated from raw http.createServer to Express to support:
//   - JWT auth middleware (Supabase)
//   - Stripe webhook (needs raw body)
//   - Cleaner static file serving
//
// All existing endpoints preserved with identical behavior:
//   /odds?sport=mlb     (5-min cache, filtered books, grace window)
//   /scores             (MLB live, 30s cache)
//   /masters            (PGA, 60s cache)
//   /line-moves?sport=  (movement tracking)
//   /morning-scan       (last scan)
//   /morning-scan/run   POST → trigger scan
//   /ai-brief           POST → Anthropic proxy
//   /grid.html, /, /favicon.svg, /index.html
//
// New endpoints (Phase 1):
//   /api/stripe/webhook       POST (raw body, Stripe signature verified)
//   /api/me                   GET  (requires auth)
//   /api/stripe/create-checkout POST (requires auth, Phase 2 client)
// =============================================================================

require('dotenv').config();
const express = require('express');
const https = require('https');
const path = require('path');
const fs = require('fs');

const morningScan = require('./morning-scan');
morningScan.scheduleScan(
  process.env.ODDS_API_KEY || '4e4c9bc2ffc7311be69697d28952cf1a',
  { t1Min: 140, t1Max: 199, t11Min: 115, t11Max: 135, t12Min: 110 }
);

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ODDS_API_KEY || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';

// ─── Auth & Stripe modules (Phase 1 SaaS) ──────────────────────────────────
const { stripeWebhookHandler } = require('./server/stripe-webhook');
const { requireAuth, supabaseAdmin } = require('./server/auth');
const { createCheckoutSession } = require('./server/stripe-checkout');
const { createBillingPortalSession } = require('./server/stripe-billing-portal');
const apiRoutes = require('./server/api-routes');

// =============================================================================
// MIDDLEWARE — order matters
// =============================================================================
// CORS: keep wide-open for now (matches old behavior)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Redirect bare apex (actionsodds.com) → canonical (www.actionsodds.com).
// Preserves path + query. Skips local dev (host matches no apex).
app.use((req, res, next) => {
  const host = (req.headers.host || '').toLowerCase();
  if (host === 'actionsodds.com') {
    return res.redirect(301, `https://www.actionsodds.com${req.originalUrl}`);
  }
  next();
});

// IMPORTANT: Stripe webhook MUST receive the raw request body for signature
// verification. This route is registered BEFORE express.json() so the body
// stays as a Buffer here, then JSON parsing applies to all later routes.
app.post(
  '/api/stripe/webhook',
  express.raw({ type: 'application/json' }),
  stripeWebhookHandler
);

// JSON body parser for all other routes
app.use(express.json({ limit: '1mb' }));

// =============================================================================
// CONFIG (unchanged from old server.js)
// =============================================================================
const SPORT_KEYS = {
  mlb: 'baseball_mlb',
  nhl: 'icehockey_nhl',
  nba: 'basketball_nba',
  pga: 'golf_masters_tournament_winner',
  nfl: 'americanfootball_nfl',
  ncaaf: 'americanfootball_ncaaf',
  ncaab: 'basketball_ncaab',
  ufc: 'mma_mixed_martial_arts'
};
const GOLF_SPORTS = ['pga'];
const ALLOWED_BOOKS = ['caesars', 'hard_rock_bet', 'draftkings', 'fanduel', 'betmgm'];

// =============================================================================
// CACHE — 5 min per sport (unchanged)
// =============================================================================
const cache = {};
const CACHE_TTL = 5 * 60 * 1000;

function getCached(sport) {
  const entry = cache[sport];
  if (entry && (Date.now() - entry.timestamp) < CACHE_TTL) {
    console.log(`[CACHE] HIT for ${sport}, age: ${Math.round((Date.now() - entry.timestamp) / 1000)}s`);
    return entry.data;
  }
  return null;
}
function setCache(sport, data) {
  cache[sport] = { data, timestamp: Date.now() };
  console.log(`[CACHE] SET for ${sport}, ${Array.isArray(data) ? data.length + ' games' : 'error'}`);
}

function getOddsUrl(sport) {
  const key = SPORT_KEYS[sport] || SPORT_KEYS.mlb;
  if (GOLF_SPORTS.includes(sport)) {
    return `https://api.the-odds-api.com/v4/sports/${key}/odds/?apiKey=${API_KEY}&regions=us&markets=outrights&oddsFormat=american&dateFormat=iso`;
  }
  return `https://api.the-odds-api.com/v4/sports/${key}/odds/?apiKey=${API_KEY}&regions=us&markets=h2h,spreads,totals&oddsFormat=american&dateFormat=iso`;
}

function processGames(games, sport) {
  if (!Array.isArray(games)) return games;
  const now = Date.now();
  const GRACE_MS = 30 * 60 * 1000;
  if (GOLF_SPORTS.includes(sport)) {
    return games.map(g => Object.assign({}, g, {
      bookmakers: g.bookmakers.filter(b => ALLOWED_BOOKS.includes(b.key))
    }));
  }
  return games
    .filter(g => (now - new Date(g.commence_time).getTime()) < GRACE_MS)
    .map(g => Object.assign({}, g, {
      bookmakers: g.bookmakers.filter(b => ALLOWED_BOOKS.includes(b.key))
    }));
}

// =============================================================================
// LINE MOVEMENT TRACKING (unchanged)
// =============================================================================
const openingLines = {};

function trackLines(sport, games) {
  if (!Array.isArray(games)) return;
  const key = sport + '_lines';
  if (!openingLines[key]) openingLines[key] = {};
  games.forEach(g => {
    const gameKey = g.away_team + '@' + g.home_team;
    if (!openingLines[key][gameKey]) openingLines[key][gameKey] = {};
    g.bookmakers.forEach(bm => {
      if (openingLines[key][gameKey][bm.key]) return;
      const h2h = bm.markets && bm.markets.find(m => m.key === 'h2h');
      if (!h2h) return;
      const ho = h2h.outcomes.find(o => o.name === g.home_team);
      const ao = h2h.outcomes.find(o => o.name === g.away_team);
      if (ho || ao) {
        openingLines[key][gameKey][bm.key] = {
          time: Date.now(),
          home: g.home_team,
          away: g.away_team,
          homeOpen: ho ? ho.price : null,
          awayOpen: ao ? ao.price : null
        };
      }
    });
  });
}

function getLineMovements(sport) {
  const key = sport + '_lines';
  const lines = openingLines[key] || {};
  const cached = getCached(sport);
  if (!cached || !Array.isArray(cached)) return [];
  const movements = [];
  const seen = {};
  cached.forEach(g => {
    const gameKey = g.away_team + '@' + g.home_team;
    const gameLines = lines[gameKey];
    if (!gameLines) return;
    g.bookmakers.forEach(bm => {
      const opening = gameLines[bm.key];
      if (!opening) return;
      const h2h = bm.markets && bm.markets.find(m => m.key === 'h2h');
      if (!h2h) return;
      if (opening.homeOpen != null) {
        const homeCurrent = h2h.outcomes.find(o => o.name === g.home_team);
        if (homeCurrent) {
          const diff = Math.abs(homeCurrent.price - opening.homeOpen);
          if (diff >= 10 && !seen[gameKey + '_home']) {
            seen[gameKey + '_home'] = true;
            movements.push({ game: gameKey, team: g.home_team, book: bm.key, open: opening.homeOpen, current: homeCurrent.price, diff });
          }
        }
      }
      if (opening.awayOpen != null) {
        const awayCurrent = h2h.outcomes.find(o => o.name === g.away_team);
        if (awayCurrent) {
          const diff2 = Math.abs(awayCurrent.price - opening.awayOpen);
          if (diff2 >= 10 && !seen[gameKey + '_away']) {
            seen[gameKey + '_away'] = true;
            movements.push({ game: gameKey, team: g.away_team, book: bm.key, open: opening.awayOpen, current: awayCurrent.price, diff: diff2 });
          }
        }
      }
    });
  });
  return movements.sort((a, b) => b.diff - a.diff);
}

// =============================================================================
// SCORES & MASTERS CACHES
// =============================================================================
let scoresCache = { data: null, timestamp: 0 };
const SCORES_TTL = 30 * 1000;

let mastersCache = { data: null, timestamp: 0 };
const MASTERS_TTL = 60 * 1000;

// =============================================================================
// ROUTES — odds, scores, masters, line moves, morning scan, AI brief
// =============================================================================

// ─── /odds?sport=mlb ───
app.get('/odds', (req, res) => {
  const sport = req.query.sport || 'mlb';
  const cached = getCached(sport);
  if (cached) {
    return res.json(processGames(cached, sport));
  }
  console.log(`[API] Fetching fresh odds for ${sport}`);
  https.get(getOddsUrl(sport), apiRes => {
    let data = '';
    apiRes.on('data', chunk => data += chunk);
    apiRes.on('end', () => {
      try {
        const games = JSON.parse(data);
        if (!Array.isArray(games)) {
          console.log('[API] Non-array response:', JSON.stringify(games).slice(0, 300));
          return res.json({ error: games.message || 'API error', detail: games.error_code || 'unknown' });
        }
        console.log(`[API] Got ${games.length} games for ${sport}`);
        setCache(sport, games);
        trackLines(sport, games);
        res.json(processGames(games, sport));
      } catch (e) {
        console.log('[API] Parse error:', e.message);
        res.status(500).type('text/plain').send(data);
      }
    });
  }).on('error', err => {
    console.log('[API] Network error:', err.message);
    res.status(500).json({ error: err.message });
  });
});

// ─── /scores (MLB live) ───
app.get('/scores', (req, res) => {
  if (scoresCache.data && (Date.now() - scoresCache.timestamp) < SCORES_TTL) {
    return res.json(scoresCache.data);
  }
  const today = new Date().toISOString().split('T')[0];
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${today}&hydrate=linescore,probablePitcher(note),team,decisions,stats(type=[season],group=[pitching])`;
  https.get(url, apiRes => {
    let data = '';
    apiRes.on('data', chunk => data += chunk);
    apiRes.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        const games = [];
        if (parsed.dates && parsed.dates.length) {
          parsed.dates[0].games.forEach(g => {
            const ls = g.linescore || {};
            const innings = ls.innings ? ls.innings.map(inn => ({
              num: inn.num,
              away: inn.away ? inn.away.runs : null,
              home: inn.home ? inn.home.runs : null
            })) : [];
            const offense = ls.offense || {};
            const defense = ls.defense || {};
            const runners = [];
            if (offense.first) runners.push('1st');
            if (offense.second) runners.push('2nd');
            if (offense.third) runners.push('3rd');
            const awayPitcher = g.teams.away.probablePitcher;
            const homePitcher = g.teams.home.probablePitcher;
            function getPitcherStats(p) {
              if (!p) return null;
              const stats = { name: p.fullName, era: 'N/A', whip: 'N/A', ip: 'N/A', k9: 'N/A', fip: 'N/A', w: 0, l: 0 };
              if (p.stats) {
                p.stats.forEach(s => {
                  if (s.type && s.type.displayName === 'season' && s.stats) {
                    stats.era = s.stats.era || 'N/A';
                    stats.whip = s.stats.whip || 'N/A';
                    stats.ip = s.stats.inningsPitched || 'N/A';
                    stats.k9 = s.stats.strikeoutsPer9Inn || 'N/A';
                    stats.w = s.stats.wins || 0;
                    stats.l = s.stats.losses || 0;
                  }
                });
              }
              if (p.note) stats.note = p.note;
              return stats;
            }
            games.push({
              gameId: g.gamePk,
              status: g.status.detailedState,
              abstractState: g.status.abstractGameState,
              inning: ls.currentInning || 0,
              inningHalf: ls.inningHalf || '',
              outs: ls.outs || 0,
              away: g.teams.away.team.name,
              home: g.teams.home.team.name,
              awayAbbr: g.teams.away.team.abbreviation || '',
              homeAbbr: g.teams.home.team.abbreviation || '',
              awayScore: g.teams.away.score || 0,
              homeScore: g.teams.home.score || 0,
              awayHits: ls.teams && ls.teams.away ? ls.teams.away.hits || 0 : 0,
              homeHits: ls.teams && ls.teams.home ? ls.teams.home.hits || 0 : 0,
              awayErrors: ls.teams && ls.teams.away ? ls.teams.away.errors || 0 : 0,
              homeErrors: ls.teams && ls.teams.home ? ls.teams.home.errors || 0 : 0,
              awayRecord: (g.teams.away.leagueRecord || {}).wins + '-' + (g.teams.away.leagueRecord || {}).losses,
              homeRecord: (g.teams.home.leagueRecord || {}).wins + '-' + (g.teams.home.leagueRecord || {}).losses,
              startTime: g.gameDate,
              innings,
              runners,
              currentPitcher: defense.pitcher ? defense.pitcher.fullName : null,
              currentBatter: offense.batter ? offense.batter.fullName : null,
              pitchCount: null,
              balls: ls.balls || 0,
              strikes: ls.strikes || 0,
              awayProbable: awayPitcher ? awayPitcher.fullName : 'TBD',
              homeProbable: homePitcher ? homePitcher.fullName : 'TBD',
              awayPitcherStats: getPitcherStats(awayPitcher),
              homePitcherStats: getPitcherStats(homePitcher),
              awayWins: (g.teams.away.leagueRecord || {}).wins || 0,
              awayLosses: (g.teams.away.leagueRecord || {}).losses || 0,
              homeWins: (g.teams.home.leagueRecord || {}).wins || 0,
              homeLosses: (g.teams.home.leagueRecord || {}).losses || 0,
              decisions: g.decisions ? {
                winner: g.decisions.winner ? g.decisions.winner.fullName : null,
                loser: g.decisions.loser ? g.decisions.loser.fullName : null,
                save: g.decisions.save ? g.decisions.save.fullName : null
              } : null
            });
          });
        }
        scoresCache = { data: games, timestamp: Date.now() };
        res.json(games);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });
  }).on('error', err => {
    res.status(500).json({ error: err.message });
  });
});

// ─── /masters (PGA leaderboard) ───
app.get('/masters', (req, res) => {
  if (mastersCache.data && mastersCache.data.players && mastersCache.data.players.length && (Date.now() - mastersCache.timestamp) < MASTERS_TTL) {
    return res.json(mastersCache.data);
  }
  const urls = [
    'https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard/401811941',
    'https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard',
    'https://site.web.api.espn.com/apis/site/v3/sports/golf/pga/leaderboard?event=401811941'
  ];
  let urlIndex = 0;

  function tryUrl() {
    if (urlIndex >= urls.length) {
      console.log('[MASTERS] All ESPN endpoints failed, using known R2 data');
      const fallback = {
        tournament: 'Masters Tournament',
        status: 'Round 2 - Complete',
        players: [
          { name: 'Rory McIlroy', position: '1', score: '-10', today: '-5', thru: 'F', rounds: ['67','63'], status: '' },
          { name: 'Patrick Reed', position: 'T2', score: '-6', today: '-4', thru: 'F', rounds: ['69','65'], status: '' },
          { name: 'Sam Burns', position: 'T2', score: '-6', today: '-1', thru: 'F', rounds: ['67','67'], status: '' },
          { name: 'Tommy Fleetwood', position: 'T4', score: '-5', today: '-3', thru: 'F', rounds: ['70','65'], status: '' },
          { name: 'Justin Rose', position: 'T4', score: '-5', today: '-3', thru: 'F', rounds: ['70','65'], status: '' },
          { name: 'Shane Lowry', position: 'T4', score: '-5', today: '-3', thru: 'F', rounds: ['70','65'], status: '' },
          { name: 'Cameron Young', position: 'T7', score: '-4', today: '-2', thru: 'F', rounds: ['70','66'], status: '' },
          { name: 'Scottie Scheffler', position: 'T8', score: '-3', today: '-1', thru: 'F', rounds: ['70','67'], status: '' }
        ]
      };
      mastersCache = { data: fallback, timestamp: Date.now() };
      return res.json(fallback);
    }
    const url = urls[urlIndex];
    console.log('[MASTERS] Trying: ' + url);
    https.get(url, apiRes => {
      let data = '';
      apiRes.on('data', chunk => data += chunk);
      apiRes.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.code || parsed.message || (!parsed.events && !parsed.competitions && !parsed.competitors && !parsed.leaderboard)) {
            urlIndex++; return tryUrl();
          }
          const result = { tournament: 'Masters Tournament', status: '', players: [] };
          let competitors = null;
          if (parsed.events && parsed.events[0]) {
            const event = parsed.events[0];
            result.tournament = event.name || 'Masters Tournament';
            result.status = event.status && event.status.type ? event.status.type.detail : '';
            const comp = event.competitions && event.competitions[0];
            if (comp) competitors = comp.competitors;
          } else if (parsed.competitions && parsed.competitions[0]) {
            competitors = parsed.competitions[0].competitors;
          } else if (parsed.competitors) {
            competitors = parsed.competitors;
          }
          if (competitors && competitors.length) {
            console.log(`[MASTERS] Found ${competitors.length} competitors`);
            result.players = competitors.map(c => {
              const athlete = c.athlete || {};
              const stats = {};
              if (c.statistics) c.statistics.forEach(s => { stats[s.name] = s.value; });
              return {
                name: athlete.displayName || athlete.shortName || c.displayName || 'Unknown',
                position: c.status && c.status.position ? c.status.position.displayName : (c.sortOrder || c.order || ''),
                score: c.score || c.totalScore || stats.relativeScore || stats.totalScore || '—',
                today: stats.currentRoundScore || c.currentRoundScore || stats.today || '—',
                thru: stats.thru || c.thru || '—',
                rounds: c.linescores ? c.linescores.map(r => r.value || r.displayValue) : [],
                status: c.status ? (c.status.displayValue || '') : ''
              };
            }).sort((a, b) => (parseInt(a.position) || 999) - (parseInt(b.position) || 999));
            mastersCache = { data: result, timestamp: Date.now() };
            return res.json(result);
          }
          urlIndex++; tryUrl();
        } catch (e) {
          console.log('[MASTERS] Parse error: ' + e.message);
          urlIndex++; tryUrl();
        }
      });
    }).on('error', err => {
      console.log('[MASTERS] Network error: ' + err.message);
      urlIndex++; tryUrl();
    });
  }
  tryUrl();
});

// ─── /line-moves?sport=mlb ───
app.get('/line-moves', (req, res) => {
  const sport = req.query.sport || 'mlb';
  res.json(getLineMovements(sport));
});

// ─── /morning-scan & /morning-scan/run ───
app.get('/morning-scan', (req, res) => {
  const scan = morningScan.getLastScan();
  res.json(scan || { error: 'No scan data yet' });
});
app.post('/morning-scan/run', (req, res) => {
  res.json({ status: 'started' });
  morningScan.runMorningScan(
    process.env.ODDS_API_KEY || '4e4c9bc2ffc7311be69697d28952cf1a',
    { t1Min: 140, t1Max: 199, t11Min: 115, t11Max: 135, t12Min: 110 }
  );
});

// ─── /ai-brief (Anthropic proxy) ───
app.post('/ai-brief', (req, res) => {
  const body = JSON.stringify(req.body);
  const options = {
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': ANTHROPIC_KEY,
      'Content-Length': Buffer.byteLength(body)
    }
  };
  console.log('[AI-BRIEF] Sending to Anthropic, key present:', !!ANTHROPIC_KEY, 'key length:', ANTHROPIC_KEY.length);
  const apiReq = https.request(options, apiRes => {
    let data = '';
    apiRes.on('data', chunk => data += chunk);
    apiRes.on('end', () => {
      console.log('[AI-BRIEF] Anthropic response status:', apiRes.statusCode);
      if (apiRes.statusCode !== 200) console.log('[AI-BRIEF] Error body:', data.slice(0, 500));
      res.status(apiRes.statusCode).type('application/json').send(data);
    });
  });
  apiReq.on('error', err => res.status(500).json({ error: err.message }));
  apiReq.write(body);
  apiReq.end();
});

// =============================================================================
// PHASE 1 SAAS ROUTES
// =============================================================================

// /api/me — verify auth, return current user info
app.get('/api/me', requireAuth, async (req, res) => {
  try {
    const [profileRes, subsRes] = await Promise.all([
      supabaseAdmin.from('profiles')
        .select('display_name, is_admin, starting_bankroll, current_bankroll')
        .eq('user_id', req.user.id).single(),
      supabaseAdmin.from('subscriptions')
        .select('sport_id, cadence, is_bundle, status, current_period_end, cancel_at_period_end')
        .eq('user_id', req.user.id).order('sport_id'),
    ]);
    res.json({
      id: req.user.id,
      email: req.user.email,
      display_name: profileRes.data?.display_name || req.user.email,
      is_admin: !!profileRes.data?.is_admin,
      starting_bankroll: Number(profileRes.data?.starting_bankroll) || 0,
      current_bankroll: Number(profileRes.data?.current_bankroll) || 0,
      subscriptions: subsRes.data || [],
    });
  } catch (err) {
    console.error('/api/me error:', err);
    res.status(500).json({ error: 'Failed to load profile' });
  }
});

// /api/stripe/create-checkout — start a Stripe Checkout session (Phase 2 client)
app.post('/api/stripe/create-checkout', requireAuth, createCheckoutSession);
app.post('/api/stripe/billing-portal', requireAuth, createBillingPortalSession);

// Phase 3 API routes
app.use(apiRoutes);

// =============================================================================
// STATIC FILE SERVING
// =============================================================================
// Serve everything in public/ as static (auth pages, css, etc.)
app.use(express.static(path.join(__dirname, 'public'), {
  extensions: ['html'],
  maxAge: 0,
}));

// Explicit handlers for backwards compat with old direct URLs
app.get('/grid.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'grid.html')));
app.get('/favicon.svg', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(path.join(__dirname, 'public', 'favicon.svg'));
});

// Root and /index.html — main dashboard
app.get(['/', '/index.html'], (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 404
app.use((req, res) => res.status(404).type('text/plain').send('Not found'));

// Start server
app.listen(PORT, () => {
  console.log(`Action's Odds running on port ${PORT}`);
  console.log(`  Supabase: ${process.env.SUPABASE_URL ? '✓' : '✗ MISSING'}`);
  console.log(`  Stripe:   ${process.env.STRIPE_SECRET_KEY ? '✓ ' + (process.env.STRIPE_SECRET_KEY.startsWith('sk_test_') ? '(TEST)' : '(LIVE)') : '✗ MISSING'}`);
});
