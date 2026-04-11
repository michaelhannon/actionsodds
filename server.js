const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ODDS_API_KEY || '8aa732b52276764387926d1c24f194c2';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';

const SPORT_KEYS = {
  mlb: 'baseball_mlb',
  nhl: 'icehockey_nhl',
  nba: 'basketball_nba',
  pga: 'golf_pga_championship',
  nfl: 'americanfootball_nfl',
  ncaaf: 'americanfootball_ncaaf',
  ncaab: 'basketball_ncaab',
  ufc: 'mma_mixed_martial_arts'
};
const ALLOWED_BOOKS = ['caesars', 'hard_rock_bet', 'draftkings', 'fanduel', 'betmgm'];

function getOddsUrl(sport) {
  const key = SPORT_KEYS[sport] || SPORT_KEYS.mlb;
  return `https://api.the-odds-api.com/v4/sports/${key}/odds/?apiKey=${API_KEY}&regions=us&markets=h2h,spreads,totals&oddsFormat=american&dateFormat=iso`;
}

function fetchOdds(res, sport) {
  https.get(getOddsUrl(sport||'mlb'), (apiRes) => {
    let data = '';
    apiRes.on('data', chunk => data += chunk);
    apiRes.on('end', () => {
      try {
        const games = JSON.parse(data);
        const now = Date.now();
        const GRACE_MS = 30 * 60 * 1000; // 30 min grace after first pitch
        console.log('Current UTC time:', new Date().toISOString());
        console.log('Total games from API:', games.length);
        games.forEach(g => {
          const diff = (now - new Date(g.commence_time).getTime());
          console.log(g.away_team, '@', g.home_team, g.commence_time, 'diff_mins:', Math.round(diff/60000));
        });
        const filtered = games
          .filter(game => (now - new Date(game.commence_time).getTime()) < GRACE_MS)
          .map(game => ({
            ...game,
            bookmakers: game.bookmakers.filter(b => ALLOWED_BOOKS.includes(b.key))
          }));
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(filtered));
      } catch(e) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(data);
      }
    });
  }).on('error', (err) => {
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: err.message }));
  });
}

function proxyAnthropic(req, res) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': ANTHROPIC_KEY
      }
    };
    const apiReq = https.request(options, (apiRes) => {
      let data = '';
      apiRes.on('data', chunk => data += chunk);
      apiRes.on('end', () => {
        res.writeHead(apiRes.statusCode, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(data);
      });
    });
    apiReq.on('error', (err) => {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: err.message }));
    });
    apiReq.write(body);
    apiReq.end();
  });
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST,GET', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end(); return;
  }
  if (req.url.startsWith('/odds')) {
    const sport = new URL('http://x'+req.url).searchParams.get('sport') || 'mlb';
    fetchOdds(res, sport); return;
  }
  if (req.url === '/ai-brief' && req.method === 'POST') { proxyAnthropic(req, res); return; }
  if (req.url === '/favicon.svg') {
    const filePath = require('path').join(__dirname, 'public', 'favicon.svg');
    require('fs').readFile(filePath, (err, content) => {
      if (err) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' });
      res.end(content);
    }); return;
  }
  if (req.url === '/' || req.url === '/index.html') {
    const filePath = path.join(__dirname, 'public', 'index.html');
    fs.readFile(filePath, (err, content) => {
      if (err) { res.writeHead(500); res.end('Error'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' });
      res.end(content);
    }); return;
  }
  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => console.log(`Action's Odds running on port ${PORT}`));
