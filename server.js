const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ODDS_API_KEY || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';

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

// =====================
// CACHE — 5 min per sport
// =====================
const cache = {};
const CACHE_TTL = 5 * 60 * 1000;

function getCached(sport) {
  const entry = cache[sport];
  if (entry && (Date.now() - entry.timestamp) < CACHE_TTL) {
    console.log('[CACHE] HIT for ' + sport + ', age: ' + Math.round((Date.now() - entry.timestamp) / 1000) + 's');
    return entry.data;
  }
  return null;
}

function setCache(sport, data) {
  cache[sport] = { data: data, timestamp: Date.now() };
  console.log('[CACHE] SET for ' + sport + ', ' + (Array.isArray(data) ? data.length + ' games' : 'error'));
}

function getOddsUrl(sport) {
  const key = SPORT_KEYS[sport] || SPORT_KEYS.mlb;
  if (GOLF_SPORTS.includes(sport)) {
    return 'https://api.the-odds-api.com/v4/sports/' + key + '/odds/?apiKey=' + API_KEY + '&regions=us&markets=outrights&oddsFormat=american&dateFormat=iso';
  }
  return 'https://api.the-odds-api.com/v4/sports/' + key + '/odds/?apiKey=' + API_KEY + '&regions=us&markets=h2h,spreads,totals&oddsFormat=american&dateFormat=iso';
}

function processGames(games, sport) {
  if (!Array.isArray(games)) return games;
  var now = Date.now();
  var GRACE_MS = 30 * 60 * 1000;

  if (GOLF_SPORTS.includes(sport)) {
    return games.map(function(game) {
      return Object.assign({}, game, {
        bookmakers: game.bookmakers.filter(function(b) { return ALLOWED_BOOKS.includes(b.key); })
      });
    });
  }

  return games
    .filter(function(game) { return (now - new Date(game.commence_time).getTime()) < GRACE_MS; })
    .map(function(game) {
      return Object.assign({}, game, {
        bookmakers: game.bookmakers.filter(function(b) { return ALLOWED_BOOKS.includes(b.key); })
      });
    });
}

function fetchOdds(res, sport) {
  var cached = getCached(sport);
  if (cached) {
    var filtered = processGames(cached, sport);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(filtered));
    return;
  }

  console.log('[API] Fetching fresh odds for ' + sport);
  https.get(getOddsUrl(sport || 'mlb'), function(apiRes) {
    var data = '';
    apiRes.on('data', function(chunk) { data += chunk; });
    apiRes.on('end', function() {
      try {
        var games = JSON.parse(data);

        if (!Array.isArray(games)) {
          console.log('[API] Non-array response:', JSON.stringify(games).slice(0, 300));
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ error: games.message || 'API error', detail: games.error_code || 'unknown' }));
          return;
        }

        console.log('[API] Got ' + games.length + ' games for ' + sport);
        setCache(sport, games);
        trackLines(sport, games);

        var filtered = processGames(games, sport);
        console.log('[API] ' + filtered.length + ' games after filtering');

        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(filtered));
      } catch (e) {
        console.log('[API] Parse error:', e.message);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(data);
      }
    });
  }).on('error', function(err) {
    console.log('[API] Network error:', err.message);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: err.message }));
  });
}

function proxyAnthropic(req, res) {
  var body = '';
  req.on('data', function(chunk) { body += chunk; });
  req.on('end', function() {
    var options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': ANTHROPIC_KEY
      }
    };
    console.log('[AI-BRIEF] Sending to Anthropic, key present:', !!ANTHROPIC_KEY, 'key length:', ANTHROPIC_KEY.length);
    var apiReq = https.request(options, function(apiRes) {
      var data = '';
      apiRes.on('data', function(chunk) { data += chunk; });
      apiRes.on('end', function() {
        console.log('[AI-BRIEF] Anthropic response status:', apiRes.statusCode);
        if (apiRes.statusCode !== 200) console.log('[AI-BRIEF] Error body:', data.slice(0, 500));
        res.writeHead(apiRes.statusCode, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(data);
      });
    });
    apiReq.on('error', function(err) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: err.message }));
    });
    apiReq.write(body);
    apiReq.end();
  });
}

// =====================
// LINE MOVEMENT TRACKING
// =====================
var openingLines = {};

function trackLines(sport, games) {
  if (!Array.isArray(games)) return;
  var key = sport + '_lines';
  if (!openingLines[key]) openingLines[key] = {};
  games.forEach(function(g) {
    var gameKey = g.away_team + '@' + g.home_team;
    if (!openingLines[key][gameKey]) {
      // Store opening lines
      var bm = g.bookmakers && g.bookmakers[0];
      if (!bm) return;
      var h2h = bm.markets && bm.markets.find(function(m) { return m.key === 'h2h'; });
      if (h2h) {
        openingLines[key][gameKey] = {
          time: Date.now(),
          home: g.home_team,
          away: g.away_team,
          homeOpen: h2h.outcomes.find(function(o) { return o.name === g.home_team; }),
          awayOpen: h2h.outcomes.find(function(o) { return o.name === g.away_team; })
        };
      }
    }
  });
}

function getLineMovements(sport) {
  var key = sport + '_lines';
  var lines = openingLines[key] || {};
  var cached = getCached(sport);
  if (!cached || !Array.isArray(cached)) return [];
  var movements = [];
  cached.forEach(function(g) {
    var gameKey = g.away_team + '@' + g.home_team;
    var opening = lines[gameKey];
    if (!opening) return;
    g.bookmakers.forEach(function(bm) {
      var h2h = bm.markets && bm.markets.find(function(m) { return m.key === 'h2h'; });
      if (!h2h) return;
      var homeCurrent = h2h.outcomes.find(function(o) { return o.name === g.home_team; });
      var awayCurrent = h2h.outcomes.find(function(o) { return o.name === g.away_team; });
      if (homeCurrent && opening.homeOpen) {
        var diff = Math.abs((homeCurrent.price || 0) - (opening.homeOpen.price || 0));
        if (diff >= 10) {
          movements.push({
            game: gameKey,
            team: g.home_team,
            book: bm.key,
            open: opening.homeOpen.price,
            current: homeCurrent.price,
            diff: diff
          });
        }
      }
    });
  });
  return movements.sort(function(a, b) { return b.diff - a.diff; });
}

// =====================
// MLB LIVE SCORES
// =====================
var scoresCache = { data: null, timestamp: 0 };
var SCORES_TTL = 30 * 1000; // 30 seconds

function fetchScores(res) {
  if (scoresCache.data && (Date.now() - scoresCache.timestamp) < SCORES_TTL) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(scoresCache.data));
    return;
  }
  var today = new Date().toISOString().split('T')[0];
  var url = 'https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=' + today + '&hydrate=linescore,team';
  https.get(url, function(apiRes) {
    var data = '';
    apiRes.on('data', function(chunk) { data += chunk; });
    apiRes.on('end', function() {
      try {
        var parsed = JSON.parse(data);
        var games = [];
        if (parsed.dates && parsed.dates.length) {
          parsed.dates[0].games.forEach(function(g) {
            var ls = g.linescore || {};
            games.push({
              status: g.status.detailedState,
              inning: ls.currentInning || 0,
              inningHalf: ls.inningHalf || '',
              away: g.teams.away.team.name,
              home: g.teams.home.team.name,
              awayScore: g.teams.away.score || 0,
              homeScore: g.teams.home.score || 0,
              awayRecord: (g.teams.away.leagueRecord || {}).wins + '-' + (g.teams.away.leagueRecord || {}).losses,
              homeRecord: (g.teams.home.leagueRecord || {}).wins + '-' + (g.teams.home.leagueRecord || {}).losses,
              startTime: g.gameDate
            });
          });
        }
        scoresCache = { data: games, timestamp: Date.now() };
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(games));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  }).on('error', function(err) {
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: err.message }));
  });
}

// =====================
// MASTERS LEADERBOARD
// =====================
var mastersCache = { data: null, timestamp: 0 };
var MASTERS_TTL = 60 * 1000; // 60 seconds

function fetchMasters(res) {
  if (mastersCache.data && (Date.now() - mastersCache.timestamp) < MASTERS_TTL) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(mastersCache.data));
    return;
  }
  var url = 'https://site.api.espn.com/apis/site/v2/sports/golf/pga/leaderboard';
  https.get(url, function(apiRes) {
    var data = '';
    apiRes.on('data', function(chunk) { data += chunk; });
    apiRes.on('end', function() {
      try {
        var parsed = JSON.parse(data);
        var event = parsed.events && parsed.events[0];
        var result = { tournament: '', status: '', players: [] };
        if (event) {
          result.tournament = event.name || 'Masters Tournament';
          result.status = event.status && event.status.type ? event.status.type.detail : '';
          var competition = event.competitions && event.competitions[0];
          if (competition && competition.competitors) {
            result.players = competition.competitors.map(function(c) {
              var athlete = c.athlete || {};
              var stats = {};
              if (c.statistics) {
                c.statistics.forEach(function(s) { stats[s.name] = s.value; });
              } else if (c.linescores) {
                // Some ESPN formats use linescores
              }
              return {
                name: athlete.displayName || athlete.shortName || 'Unknown',
                position: c.status && c.status.position ? c.status.position.displayName : (c.sortOrder || ''),
                score: c.score || c.totalScore || stats.totalScore || '—',
                today: stats.currentRoundScore || c.currentRoundScore || stats.today || '—',
                thru: stats.thru || c.thru || '—',
                rounds: c.linescores ? c.linescores.map(function(r) { return r.value; }) : [],
                status: c.status ? c.status.displayValue : ''
              };
            }).sort(function(a, b) { return (parseInt(a.position) || 999) - (parseInt(b.position) || 999); });
          }
        }
        mastersCache = { data: result, timestamp: Date.now() };
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  }).on('error', function(err) {
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: err.message }));
  });
}

var server = http.createServer(function(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST,GET', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end(); return;
  }
  if (req.url.startsWith('/odds')) {
    var sport = new URL('http://x' + req.url).searchParams.get('sport') || 'mlb';
    fetchOdds(res, sport); return;
  }
  if (req.url === '/scores') { fetchScores(res); return; }
  if (req.url === '/masters') { fetchMasters(res); return; }
  if (req.url.startsWith('/line-moves')) {
    var moveSport = new URL('http://x' + req.url).searchParams.get('sport') || 'mlb';
    var moves = getLineMovements(moveSport);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(moves));
    return;
  }
  if (req.url === '/ai-brief' && req.method === 'POST') { proxyAnthropic(req, res); return; }
  if (req.url === '/favicon.svg') {
    var filePath = path.join(__dirname, 'public', 'favicon.svg');
    fs.readFile(filePath, function(err, content) {
      if (err) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' });
      res.end(content);
    }); return;
  }
  if (req.url === '/' || req.url === '/index.html') {
    var filePath2 = path.join(__dirname, 'public', 'index.html');
    fs.readFile(filePath2, function(err, content) {
      if (err) { res.writeHead(500); res.end('Error'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' });
      res.end(content);
    }); return;
  }
  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, function() { console.log('Action\'s Odds running on port ' + PORT); });
