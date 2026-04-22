const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const morningScan = require('./morning-scan');
morningScan.scheduleScan(process.env.ODDS_API_KEY||'75d619683f0d4cf8366179321ee08cc7',{t1Min:140,t1Max:199,t11Min:115,t11Max:135,t12Min:110});


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
    if (!openingLines[key][gameKey]) openingLines[key][gameKey] = {};
    // Store opening line per book (only first time seen)
    g.bookmakers.forEach(function(bm) {
      if (openingLines[key][gameKey][bm.key]) return; // already stored
      var h2h = bm.markets && bm.markets.find(function(m) { return m.key === 'h2h'; });
      if (!h2h) return;
      var ho = h2h.outcomes.find(function(o) { return o.name === g.home_team; });
      var ao = h2h.outcomes.find(function(o) { return o.name === g.away_team; });
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
  var key = sport + '_lines';
  var lines = openingLines[key] || {};
  var cached = getCached(sport);
  if (!cached || !Array.isArray(cached)) return [];
  var movements = [];
  var seen = {}; // dedupe by game
  cached.forEach(function(g) {
    var gameKey = g.away_team + '@' + g.home_team;
    var gameLines = lines[gameKey];
    if (!gameLines) return;
    g.bookmakers.forEach(function(bm) {
      var opening = gameLines[bm.key];
      if (!opening) return;
      var h2h = bm.markets && bm.markets.find(function(m) { return m.key === 'h2h'; });
      if (!h2h) return;
      // Check home team movement
      if (opening.homeOpen != null) {
        var homeCurrent = h2h.outcomes.find(function(o) { return o.name === g.home_team; });
        if (homeCurrent) {
          var diff = Math.abs(homeCurrent.price - opening.homeOpen);
          if (diff >= 10 && !seen[gameKey + '_home']) {
            seen[gameKey + '_home'] = true;
            movements.push({
              game: gameKey,
              team: g.home_team,
              book: bm.key,
              open: opening.homeOpen,
              current: homeCurrent.price,
              diff: diff
            });
          }
        }
      }
      // Check away team movement
      if (opening.awayOpen != null) {
        var awayCurrent = h2h.outcomes.find(function(o) { return o.name === g.away_team; });
        if (awayCurrent) {
          var diff2 = Math.abs(awayCurrent.price - opening.awayOpen);
          if (diff2 >= 10 && !seen[gameKey + '_away']) {
            seen[gameKey + '_away'] = true;
            movements.push({
              game: gameKey,
              team: g.away_team,
              book: bm.key,
              open: opening.awayOpen,
              current: awayCurrent.price,
              diff: diff2
            });
          }
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
  var url = 'https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=' + today + '&hydrate=linescore,probablePitcher(note),team,decisions,stats(type=[season],group=[pitching])';
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
            var innings = [];
            if (ls.innings) {
              innings = ls.innings.map(function(inn) {
                return { num: inn.num, away: inn.away ? inn.away.runs : null, home: inn.home ? inn.home.runs : null };
              });
            }
            // Current play state
            var offense = ls.offense || {};
            var defense = ls.defense || {};
            var runners = [];
            if (offense.first) runners.push('1st');
            if (offense.second) runners.push('2nd');
            if (offense.third) runners.push('3rd');

            var awayPitcher = g.teams.away.probablePitcher;
            var homePitcher = g.teams.home.probablePitcher;

            // Extract pitcher season stats if available
            function getPitcherStats(pitcher) {
              if (!pitcher) return null;
              var stats = { name: pitcher.fullName, era: 'N/A', whip: 'N/A', ip: 'N/A', k9: 'N/A', fip: 'N/A', w: 0, l: 0 };
              if (pitcher.stats) {
                pitcher.stats.forEach(function(s) {
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
              if (pitcher.note) stats.note = pitcher.note;
              return stats;
            }

            var awayPitcherStats = getPitcherStats(awayPitcher);
            var homePitcherStats = getPitcherStats(homePitcher);

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
              innings: innings,
              runners: runners,
              currentPitcher: defense.pitcher ? defense.pitcher.fullName : null,
              currentBatter: offense.batter ? offense.batter.fullName : null,
              pitchCount: defense.pitcher && defense.pitcher.stats ? null : null,
              balls: ls.balls || 0,
              strikes: ls.strikes || 0,
              awayProbable: awayPitcher ? awayPitcher.fullName : 'TBD',
              homeProbable: homePitcher ? homePitcher.fullName : 'TBD',
              awayPitcherStats: awayPitcherStats,
              homePitcherStats: homePitcherStats,
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
  if (mastersCache.data && mastersCache.data.players && mastersCache.data.players.length && (Date.now() - mastersCache.timestamp) < MASTERS_TTL) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(mastersCache.data));
    return;
  }
  // Try multiple ESPN endpoints
  var urls = [
    'https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard/401811941',
    'https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard',
    'https://site.web.api.espn.com/apis/site/v3/sports/golf/pga/leaderboard?event=401811941'
  ];
  var urlIndex = 0;

  function tryUrl() {
    if (urlIndex >= urls.length) {
      // All URLs failed — return cached or hardcoded fallback from search results
      console.log('[MASTERS] All ESPN endpoints failed, using known R2 data');
      var fallback = {
        tournament: 'Masters Tournament',
        status: 'Round 2 - Complete',
        players: [
          {name:'Rory McIlroy',position:'1',score:'-10',today:'-5',thru:'F',rounds:['67','63'],status:''},
          {name:'Patrick Reed',position:'T2',score:'-6',today:'-4',thru:'F',rounds:['69','65'],status:''},
          {name:'Sam Burns',position:'T2',score:'-6',today:'-1',thru:'F',rounds:['67','67'],status:''},
          {name:'Tommy Fleetwood',position:'T4',score:'-5',today:'-3',thru:'F',rounds:['70','65'],status:''},
          {name:'Justin Rose',position:'T4',score:'-5',today:'-3',thru:'F',rounds:['70','65'],status:''},
          {name:'Shane Lowry',position:'T4',score:'-5',today:'-3',thru:'F',rounds:['70','65'],status:''},
          {name:'Cameron Young',position:'T7',score:'-4',today:'-2',thru:'F',rounds:['70','66'],status:''},
          {name:'Scottie Scheffler',position:'T8',score:'-3',today:'-1',thru:'F',rounds:['70','67'],status:''}
        ]
      };
      mastersCache = { data: fallback, timestamp: Date.now() };
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(fallback));
      return;
    }

    var url = urls[urlIndex];
    console.log('[MASTERS] Trying: ' + url);
    https.get(url, function(apiRes) {
      var data = '';
      apiRes.on('data', function(chunk) { data += chunk; });
      apiRes.on('end', function() {
        try {
          var parsed = JSON.parse(data);
          // Check if response has useful data
          if (parsed.code || parsed.message || (!parsed.events && !parsed.competitions && !parsed.competitors && !parsed.leaderboard)) {
            console.log('[MASTERS] Endpoint ' + urlIndex + ' returned error or empty, trying next');
            urlIndex++;
            tryUrl();
            return;
          }
          
          var result = { tournament: 'Masters Tournament', status: '', players: [] };
          
          // Handle different ESPN response formats
          var competitors = null;
          if (parsed.events && parsed.events[0]) {
            var event = parsed.events[0];
            result.tournament = event.name || 'Masters Tournament';
            result.status = event.status && event.status.type ? event.status.type.detail : '';
            var comp = event.competitions && event.competitions[0];
            if (comp) competitors = comp.competitors;
          } else if (parsed.competitions && parsed.competitions[0]) {
            competitors = parsed.competitions[0].competitors;
          } else if (parsed.competitors) {
            competitors = parsed.competitors;
          }

          if (competitors && competitors.length) {
            console.log('[MASTERS] Found ' + competitors.length + ' competitors');
            result.players = competitors.map(function(c) {
              var athlete = c.athlete || {};
              var stats = {};
              if (c.statistics) c.statistics.forEach(function(s) { stats[s.name] = s.value; });
              return {
                name: athlete.displayName || athlete.shortName || c.displayName || 'Unknown',
                position: c.status && c.status.position ? c.status.position.displayName : (c.sortOrder || c.order || ''),
                score: c.score || c.totalScore || stats.relativeScore || stats.totalScore || '—',
                today: stats.currentRoundScore || c.currentRoundScore || stats.today || '—',
                thru: stats.thru || c.thru || '—',
                rounds: c.linescores ? c.linescores.map(function(r) { return r.value || r.displayValue; }) : [],
                status: c.status ? (c.status.displayValue || '') : ''
              };
            }).sort(function(a, b) { return (parseInt(a.position) || 999) - (parseInt(b.position) || 999); });
            mastersCache = { data: result, timestamp: Date.now() };
            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify(result));
          } else {
            console.log('[MASTERS] No competitors in response, trying next URL');
            urlIndex++;
            tryUrl();
          }
        } catch (e) {
          console.log('[MASTERS] Parse error: ' + e.message);
          urlIndex++;
          tryUrl();
        }
      });
    }).on('error', function(err) {
      console.log('[MASTERS] Network error: ' + err.message);
      urlIndex++;
      tryUrl();
    });
  }
  tryUrl();
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
  if(req.url==='/morning-scan'){const scan=morningScan.getLastScan();res.writeHead(200,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});res.end(JSON.stringify(scan||{error:'No scan data yet'}));return;}
  if(req.url==='/morning-scan/run'&&req.method==='POST'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({status:'started'}));morningScan.runMorningScan(process.env.ODDS_API_KEY||'75d619683f0d4cf8366179321ee08cc7',{t1Min:140,t1Max:199,t11Min:115,t11Max:135,t12Min:110});return;}
    if (req.url === '/ai-brief' && req.method === 'POST') { proxyAnthropic(req, res); return; }
  if (req.url === '/favicon.svg') {
    var filePath = path.join(__dirname, 'public', 'favicon.svg');
    fs.readFile(filePath, function(err, content) {
      if (err) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' });
      res.end(content);
    }); return;
  }
  if (req.url === '/grid.html') {
    var gridPath = path.join(__dirname, 'public', 'grid.html');
    fs.readFile(gridPath, function(err, content) {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(content);
    });
    return;
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
