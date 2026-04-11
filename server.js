/**
 * Prebid Monitor Server v24 (hardened)
 * =====================================
 * Multi-site prebid.js monitoring with real-time dashboard.
 *
 * Features:
 * - Sequential scanning (one site at a time, stable memory)
 * - Stealth mode (evades bot detection)
 * - Consent banner auto-clicking
 * - Auto-pause after 3 consecutive failures
 * - Captures bids, no-bids, floors, targeting, bidder timeouts
 * - Multi-page scanning with retry logic
 * - Health watchdog
 * - Auto-cleanup of old data
 * - 50 default publisher sites pre-loaded
 *
 * Environment Variables:
 *   PORT              - Server port (default: 3000)
 *   DATA_DIR          - Data directory for SQLite (default: ./data)
 *   SCAN_INTERVAL_MIN - Minutes between scan cycles (default: 5)
 *   AUCTION_WAIT_SEC  - Max seconds to wait for auctions (default: 12)
 *   AUTH_USER         - Basic auth username
 *   AUTH_PASS         - Basic auth password
 *   PAGES_PER_SITE    - Pages to scan per site (default: 1)
 */

const express = require("express");
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");
const puppeteer = require("puppeteer");

const { execSync } = require("child_process");

const app = express();
const PORT = process.env.PORT || 3000;

// =============================================================================
// PROCESS-LEVEL CRASH PROTECTION
// =============================================================================
process.on("uncaughtException", (err) => {
  console.error(`\n🔴 UNCAUGHT EXCEPTION: ${err.message}`);
  console.error(err.stack);
  isScanning = false;
  currentScanSite = null;
  killOrphanedChromium();
});

process.on("unhandledRejection", (reason) => {
  console.error(`\n🔴 UNHANDLED REJECTION: ${reason}`);
  isScanning = false;
  currentScanSite = null;
  killOrphanedChromium();
});

function killOrphanedChromium() {
  try {
    execSync("pkill -f chromium 2>/dev/null || pkill -f chrome 2>/dev/null || true", { timeout: 5000 });
    console.log("  🧹 Killed orphaned browser processes");
  } catch(e) {}
}

// =============================================================================
// CONFIG
// =============================================================================
let scanIntervalMs = (parseInt(process.env.SCAN_INTERVAL_MIN) || 5) * 60 * 1000;
const AUCTION_WAIT = (parseInt(process.env.AUCTION_WAIT_SEC) || 12) * 1000;
const PAGES_PER_SITE = parseInt(process.env.PAGES_PER_SITE) || 1;
const CONSECUTIVE_FAILURE_THRESHOLD = 3;
let autoScanEnabled = true;
let isScanning = false;
let currentScanSite = null;
let lastScanTime = null;
let scanTimer = null;
let lastScanActivity = Date.now();

// =============================================================================
// DATABASE
// =============================================================================
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "prebid-monitor.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = OFF");

db.exec(`
  CREATE TABLE IF NOT EXISTS sites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain TEXT NOT NULL UNIQUE,
    name TEXT,
    pages_json TEXT DEFAULT '["/""]',
    active INTEGER DEFAULT 1,
    consecutive_failures INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    last_scanned TEXT
  );

  CREATE TABLE IF NOT EXISTS scans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER NOT NULL,
    timestamp TEXT NOT NULL,
    url TEXT NOT NULL,
    prebid_version TEXT,
    prebid_detected INTEGER DEFAULT 0,
    total_ad_units INTEGER DEFAULT 0,
    total_bids INTEGER DEFAULT 0,
    total_wins INTEGER DEFAULT 0,
    total_no_bids INTEGER DEFAULT 0,
    avg_winning_cpm REAL DEFAULT 0,
    avg_latency REAL DEFAULT 0,
    p95_latency REAL DEFAULT 0,
    bidder_timeout INTEGER,
    floor_config_json TEXT,
    ad_server_targeting_json TEXT,
    configured_bidders_json TEXT,
    config_json TEXT,
    errors_json TEXT
  );

  CREATE TABLE IF NOT EXISTS bids (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scan_id INTEGER NOT NULL,
    site_id INTEGER NOT NULL,
    timestamp TEXT NOT NULL,
    bidder TEXT NOT NULL,
    ad_unit_code TEXT,
    cpm REAL DEFAULT 0,
    currency TEXT DEFAULT 'USD',
    width INTEGER,
    height INTEGER,
    time_to_respond INTEGER,
    media_type TEXT,
    status TEXT,
    is_winner INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS no_bids (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scan_id INTEGER NOT NULL,
    site_id INTEGER NOT NULL,
    timestamp TEXT NOT NULL,
    bidder TEXT NOT NULL,
    ad_unit_code TEXT
  );

  CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scan_id INTEGER DEFAULT 0,
    site_id INTEGER,
    timestamp TEXT NOT NULL,
    severity TEXT NOT NULL,
    message TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_bids_timestamp ON bids(timestamp);
  CREATE INDEX IF NOT EXISTS idx_bids_site ON bids(site_id);
  CREATE INDEX IF NOT EXISTS idx_bids_bidder ON bids(bidder);
  CREATE INDEX IF NOT EXISTS idx_scans_timestamp ON scans(timestamp);
  CREATE INDEX IF NOT EXISTS idx_scans_site ON scans(site_id);
  CREATE INDEX IF NOT EXISTS idx_no_bids_timestamp ON no_bids(timestamp);
  CREATE INDEX IF NOT EXISTS idx_alerts_timestamp ON alerts(timestamp);
`);

// Add columns if missing (safe for existing DBs)
try { db.exec("ALTER TABLE sites ADD COLUMN consecutive_failures INTEGER DEFAULT 0"); } catch(e) {}
try { db.exec("ALTER TABLE scans ADD COLUMN total_no_bids INTEGER DEFAULT 0"); } catch(e) {}
try { db.exec("ALTER TABLE scans ADD COLUMN bidder_timeout INTEGER"); } catch(e) {}
try { db.exec("ALTER TABLE scans ADD COLUMN floor_config_json TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE scans ADD COLUMN ad_server_targeting_json TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE scans ADD COLUMN configured_bidders_json TEXT"); } catch(e) {}

// =============================================================================
// SEED DEFAULT SITES
// =============================================================================
const siteCount = db.prepare("SELECT COUNT(*) as c FROM sites").get().c;
if (siteCount === 0) {
  const defaultSites = [
    { domain: "nypost.com", name: "NY Post", pages: ["/", "/news/", "/sports/", "/entertainment/", "/business/"] },
    { domain: "usatoday.com", name: "USA Today", pages: ["/", "/news/", "/sports/", "/money/", "/tech/"] },
    { domain: "reuters.com", name: "Reuters", pages: ["/", "/world/", "/business/", "/technology/"] },
    { domain: "independent.co.uk", name: "The Independent", pages: ["/", "/news/", "/sport/", "/tech/"] },
    { domain: "nydailynews.com", name: "NY Daily News", pages: ["/", "/news/", "/sports/", "/entertainment/"] },
    { domain: "dailymail.co.uk", name: "Daily Mail", pages: ["/", "/news/", "/sport/", "/tvshowbiz/"] },
    { domain: "newsweek.com", name: "Newsweek", pages: ["/", "/news/", "/politics/", "/tech/"] },
    { domain: "thehill.com", name: "The Hill", pages: ["/", "/policy/", "/opinion/"] },
    { domain: "washingtonexaminer.com", name: "Washington Examiner", pages: ["/", "/news/", "/policy/", "/opinion/"] },
    { domain: "bostonglobe.com", name: "Boston Globe", pages: ["/", "/metro/", "/sports/", "/business/"] },
    { domain: "sfgate.com", name: "SFGate", pages: ["/", "/local/", "/food/", "/culture/"] },
    { domain: "chicagotribune.com", name: "Chicago Tribune", pages: ["/", "/news/", "/sports/", "/entertainment/"] },
    { domain: "latimes.com", name: "LA Times", pages: ["/", "/california/", "/entertainment/", "/sports/"] },
    { domain: "bleacherreport.com", name: "Bleacher Report", pages: ["/", "/nfl", "/nba", "/mlb"] },
    { domain: "cbssports.com", name: "CBS Sports", pages: ["/", "/nfl/", "/nba/", "/mlb/", "/fantasy/"] },
    { domain: "si.com", name: "Sports Illustrated", pages: ["/", "/nfl/", "/nba/", "/college/"] },
    { domain: "sportingnews.com", name: "Sporting News", pages: ["/", "/nfl/", "/nba/", "/mlb/"] },
    { domain: "profootballtalk.nbcsports.com", name: "Pro Football Talk", pages: ["/"] },
    { domain: "people.com", name: "People", pages: ["/", "/celebrity/", "/style/", "/food/"] },
    { domain: "eonline.com", name: "E! Online", pages: ["/", "/news/", "/fashion/", "/tv/"] },
    { domain: "tmz.com", name: "TMZ", pages: ["/", "/news/", "/sports/"] },
    { domain: "rollingstone.com", name: "Rolling Stone", pages: ["/", "/music/", "/tv-movies/", "/culture/"] },
    { domain: "billboard.com", name: "Billboard", pages: ["/", "/music/", "/charts/"] },
    { domain: "allrecipes.com", name: "Allrecipes", pages: ["/", "/recipes/", "/cooking-tips/"] },
    { domain: "food.com", name: "Food.com", pages: ["/", "/recipes/"] },
    { domain: "tasteofhome.com", name: "Taste of Home", pages: ["/", "/recipes/", "/cooking/"] },
    { domain: "hgtv.com", name: "HGTV", pages: ["/", "/design/", "/shopping/"] },
    { domain: "tvguide.com", name: "TV Guide", pages: ["/", "/news/", "/listings/"] },
    { domain: "zdnet.com", name: "ZDNet", pages: ["/", "/article/", "/reviews/"] },
    { domain: "tomsguide.com", name: "Toms Guide", pages: ["/", "/news/", "/reviews/", "/best-picks/"] },
    { domain: "tomshardware.com", name: "Toms Hardware", pages: ["/", "/news/", "/reviews/", "/best-picks/"] },
    { domain: "pcmag.com", name: "PCMag", pages: ["/", "/news/", "/reviews/", "/picks/"] },
    { domain: "digitaltrends.com", name: "Digital Trends", pages: ["/", "/computing/", "/mobile/", "/home/"] },
    { domain: "techradar.com", name: "TechRadar", pages: ["/", "/news/", "/reviews/", "/best/"] },
    { domain: "investopedia.com", name: "Investopedia", pages: ["/", "/investing/", "/personal-finance/"] },
    { domain: "bankrate.com", name: "Bankrate", pages: ["/", "/mortgages/", "/banking/", "/credit-cards/"] },
    { domain: "dictionary.com", name: "Dictionary.com", pages: ["/", "/browse/", "/e/"] },
    { domain: "thesaurus.com", name: "Thesaurus.com", pages: ["/"] },
    { domain: "merriam-webster.com", name: "Merriam-Webster", pages: ["/", "/dictionary/", "/word-of-the-day"] },
    { domain: "healthline.com", name: "Healthline", pages: ["/", "/health/", "/nutrition/"] },
    { domain: "medicalnewstoday.com", name: "Medical News Today", pages: ["/", "/articles/", "/news/"] },
    { domain: "webmd.com", name: "WebMD", pages: ["/", "/a-to-z-guides/", "/fitness-exercise/"] },
    { domain: "ign.com", name: "IGN", pages: ["/", "/articles/", "/reviews/"] },
    { domain: "gamespot.com", name: "GameSpot", pages: ["/", "/news/", "/reviews/"] },
    { domain: "kotaku.com", name: "Kotaku", pages: ["/"] },
    { domain: "weather.com", name: "The Weather Channel", pages: ["/"] },
    { domain: "accuweather.com", name: "AccuWeather", pages: ["/"] },
    { domain: "tripadvisor.com", name: "TripAdvisor", pages: ["/"] },
    { domain: "edmunds.com", name: "Edmunds", pages: ["/", "/car-reviews/", "/car-news/"] },
  ];

  const insertSite = db.prepare("INSERT OR IGNORE INTO sites (domain, name, pages_json) VALUES (?, ?, ?)");
  const seedTransaction = db.transaction((sites) => {
    for (const site of sites) insertSite.run(site.domain, site.name, JSON.stringify(site.pages));
  });
  seedTransaction(defaultSites);
  const seeded = db.prepare("SELECT COUNT(*) as c FROM sites").get().c;
  console.log(`Seeded ${seeded} default publisher sites.`);
}

// =============================================================================
// PREBID EXTRACTION SCRIPT (injected into pages)
// =============================================================================
function getInjectionScript() {
  return function() {
    window.__pbResults = { bids: [], noBids: [], auctionCount: 0 };
    const origPbjs = window.pbjs || { que: [] };
    const checkPbjs = setInterval(() => {
      if (typeof window.pbjs !== 'undefined' && window.pbjs.onEvent) {
        clearInterval(checkPbjs);
        try {
          window.pbjs.onEvent('auctionEnd', function(args) {
            window.__pbResults.auctionCount++;
            if (args && args.bidsReceived) {
              args.bidsReceived.forEach(b => window.__pbResults.bids.push(b));
            }
            if (args && args.noBids) {
              args.noBids.forEach(b => window.__pbResults.noBids.push(b));
            }
          });
        } catch(e) {}
      }
    }, 200);
    setTimeout(() => clearInterval(checkPbjs), 15000);
  };
}

function getExtractScript() {
  return function() {
    const data = {
      timestamp: new Date().toISOString(),
      url: window.location.href,
      prebidDetected: false,
      prebidVersion: null,
      allBids: [],
      winners: [],
      noBids: [],
      config: null,
      floors: null,
      targeting: null,
      configuredBidders: [],
      bidderTimeout: null,
      errors: [],
    };
    try {
      if (typeof window.pbjs === 'undefined' || !window.pbjs) {
        return data;
      }
      data.prebidDetected = true;
      data.prebidVersion = window.pbjs.version || 'unknown';

      // Get bids from auction events first
      if (window.__pbResults && window.__pbResults.bids.length > 0) {
        data.allBids = window.__pbResults.bids.map(b => ({
          bidder: b.bidderCode || b.bidder || 'unknown',
          adUnitCode: b.adUnitCode || '',
          cpm: b.cpm || 0,
          currency: b.currency || 'USD',
          width: b.width || 0,
          height: b.height || 0,
          timeToRespond: b.timeToRespond || 0,
          mediaType: b.mediaType || '',
          status: b.status || 'active',
        }));
        data.noBids = (window.__pbResults.noBids || []).map(b => ({
          bidder: b.bidder || b.bidderCode || 'unknown',
          adUnitCode: b.adUnitCode || '',
        }));
      }

      // Fallback: getBidResponses
      if (data.allBids.length === 0 && window.pbjs.getBidResponses) {
        try {
          const resp = window.pbjs.getBidResponses();
          for (const adUnit in resp) {
            (resp[adUnit].bids || []).forEach(b => {
              data.allBids.push({
                bidder: b.bidderCode || b.bidder || 'unknown',
                adUnitCode: adUnit,
                cpm: b.cpm || 0,
                currency: b.currency || 'USD',
                width: b.width || 0,
                height: b.height || 0,
                timeToRespond: b.timeToRespond || 0,
                mediaType: b.mediaType || '',
                status: b.status || 'active',
              });
            });
          }
        } catch(e) { data.errors.push('getBidResponses: ' + e.message); }
      }

      // Winners
      if (window.pbjs.getAllWinningBids) {
        try {
          data.winners = window.pbjs.getAllWinningBids().map(b => ({
            bidder: b.bidderCode || 'unknown',
            adUnitCode: b.adUnitCode || '',
            cpm: b.cpm || 0,
          }));
        } catch(e) {}
      }

      // No-bids fallback
      if (data.noBids.length === 0 && window.pbjs.getNoBids) {
        try {
          data.noBids = window.pbjs.getNoBids().map(b => ({
            bidder: b.bidder || b.bidderCode || 'unknown',
            adUnitCode: b.adUnitCode || '',
          }));
        } catch(e) {}
      }

      // Config
      if (window.pbjs.getConfig) {
        try {
          const cfg = window.pbjs.getConfig();
          data.bidderTimeout = cfg.bidderTimeout || null;
          data.floors = cfg.floors || null;
          data.configuredBidders = cfg.bidderSequence ? [] : [];
          if (cfg.s2sConfig && cfg.s2sConfig.bidders) {
            data.configuredBidders = cfg.s2sConfig.bidders;
          }
        } catch(e) {}
      }

      // Ad server targeting
      if (window.pbjs.getAdserverTargeting) {
        try { data.targeting = window.pbjs.getAdserverTargeting(); } catch(e) {}
      }

    } catch(e) {
      data.errors.push(e.message);
    }
    return data;
  };
}

// =============================================================================
// STORE SCAN DATA
// =============================================================================
function storeScanData(siteId, rawData) {
  const allBids = rawData.allBids || [];
  const winners = rawData.winners || [];
  const noBids = rawData.noBids || [];
  const winnerKeys = new Set(winners.map(w => `${w.bidder}|${w.adUnitCode}`));

  const cpms = allBids.filter(b => b.cpm > 0).map(b => b.cpm);
  const avgCpm = cpms.length > 0 ? cpms.reduce((a,b) => a+b, 0) / cpms.length : 0;
  const latencies = allBids.filter(b => b.timeToRespond > 0).map(b => b.timeToRespond);
  const avgLatency = latencies.length > 0 ? latencies.reduce((a,b) => a+b, 0) / latencies.length : 0;
  const sortedLat = [...latencies].sort((a,b) => a-b);
  const p95 = sortedLat.length > 0 ? sortedLat[Math.floor(sortedLat.length * 0.95)] : 0;
  const adUnits = new Set(allBids.map(b => b.adUnitCode));

  const scanResult = db.prepare(`
    INSERT INTO scans (site_id, timestamp, url, prebid_version, prebid_detected,
      total_ad_units, total_bids, total_wins, total_no_bids,
      avg_winning_cpm, avg_latency, p95_latency,
      bidder_timeout, floor_config_json, ad_server_targeting_json, configured_bidders_json, errors_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    siteId, rawData.timestamp, rawData.url, rawData.prebidVersion,
    rawData.prebidDetected ? 1 : 0, adUnits.size, allBids.length, winners.length, noBids.length,
    avgCpm, avgLatency, p95,
    rawData.bidderTimeout || null,
    rawData.floors ? JSON.stringify(rawData.floors) : null,
    rawData.targeting ? JSON.stringify(rawData.targeting) : null,
    rawData.configuredBidders ? JSON.stringify(rawData.configuredBidders) : null,
    rawData.errors && rawData.errors.length ? JSON.stringify(rawData.errors) : null
  );
  const scanId = scanResult.lastInsertRowid;

  // Store bids
  if (allBids.length > 0) {
    const insertBid = db.prepare(`
      INSERT INTO bids (scan_id, site_id, timestamp, bidder, ad_unit_code, cpm, currency, width, height, time_to_respond, media_type, status, is_winner)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertMany = db.transaction((bids) => {
      for (const bid of bids) {
        const isWinner = winnerKeys.has(`${bid.bidder}|${bid.adUnitCode}`) ? 1 : 0;
        insertBid.run(scanId, siteId, rawData.timestamp, bid.bidder, bid.adUnitCode,
          bid.cpm || 0, bid.currency || 'USD', bid.width || null, bid.height || null,
          bid.timeToRespond || null, bid.mediaType || null, bid.status || null, isWinner);
      }
    });
    insertMany(allBids);
  }

  // Store no-bids
  if (noBids.length > 0) {
    const insertNoBid = db.prepare(`INSERT INTO no_bids (scan_id, site_id, timestamp, bidder, ad_unit_code) VALUES (?, ?, ?, ?, ?)`);
    const insertNoBids = db.transaction((nbs) => {
      for (const nb of nbs) insertNoBid.run(scanId, siteId, rawData.timestamp, nb.bidder, nb.adUnitCode || null);
    });
    insertNoBids(noBids);
  }

  // Alerts
  const insertAlert = db.prepare(`INSERT INTO alerts (scan_id, site_id, timestamp, severity, message) VALUES (?, ?, ?, ?, ?)`);
  if (latencies.length > 0 && Math.max(...latencies) > 2000)
    insertAlert.run(scanId, siteId, rawData.timestamp, "WARNING", `High latency: ${Math.max(...latencies)}ms`);
  if (allBids.length === 0 && rawData.prebidDetected)
    insertAlert.run(scanId, siteId, rawData.timestamp, "CRITICAL", "Prebid detected but no bids received");

  return scanId;
}

// =============================================================================
// SCANNER
// =============================================================================
async function scanPage(browser, site, fullUrl) {
  let page;
  try {
    const stillExists = db.prepare("SELECT id, active FROM sites WHERE id = ?").get(site.id);
    if (!stillExists || !stillExists.active) return null;

    page = await browser.newPage();
    await new Promise(r => setTimeout(r, 500));

    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
    await page.setViewport({ width: 1366, height: 768 });

    // Block heavy resources
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const type = req.resourceType();
      if (["image", "font", "media"].includes(type)) req.abort();
      else req.continue();
    });

    // Inject prebid listener
    await page.evaluateOnNewDocument(getInjectionScript());

    // Navigate with retry for "main frame too early"
    let navSuccess = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await page.goto(fullUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
        navSuccess = true;
        break;
      } catch (navErr) {
        if (navErr.message.includes("main frame") && attempt < 2) {
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }
        if (navErr.message.includes("net::ERR_")) return null;
        break;
      }
    }
    if (!navSuccess) return null;

    // Wait for page to settle
    await new Promise(r => setTimeout(r, 2000));

    // Click consent banners
    try {
      const consentSelectors = [
        '[class*="consent"] button', '[id*="consent"] button',
        '[class*="cookie"] button', '[id*="cookie"] button',
        '.fc-cta-consent', '#onetrust-accept-btn-handler',
        '.cc-accept', '.cc-allow', '[data-testid="accept-button"]',
        'button[title="Accept"]', 'button[title="Accept All"]',
        'button[title="I Accept"]', '.qc-cmp2-summary-buttons button:first-child',
      ];
      for (const sel of consentSelectors) {
        const btn = await page.$(sel);
        if (btn) { await btn.click().catch(() => {}); break; }
      }
    } catch(e) {}

    // Smart polling for prebid data
    const pollStart = Date.now();
    let hasBids = false;
    while (Date.now() - pollStart < AUCTION_WAIT) {
      const check = await page.evaluate(() => {
        if (window.__pbResults && window.__pbResults.bids.length > 0) return true;
        if (typeof window.pbjs !== 'undefined' && window.pbjs.getBidResponses) {
          const r = window.pbjs.getBidResponses();
          for (const k in r) { if (r[k].bids && r[k].bids.length > 0) return true; }
        }
        return false;
      }).catch(() => false);

      if (check) { hasBids = true; break; }
      await new Promise(r => setTimeout(r, 500));
    }

    // Extract data
    const rawData = await page.evaluate(getExtractScript());
    rawData.url = fullUrl;
    return rawData;

  } catch (err) {
    console.log(`  [${site.domain}] Page error: ${err.message.slice(0, 100)}`);
    return null;
  } finally {
    try { if (page) await page.close(); } catch(e) {}
  }
}

async function scanSite(browser, site) {
  const pages = JSON.parse(site.pages_json || '[]');
  if (pages.length === 0) pages.push("/");

  const currentSite = db.prepare("SELECT consecutive_failures, active FROM sites WHERE id = ?").get(site.id);
  if (!currentSite || !currentSite.active) return;
  if (currentSite.consecutive_failures >= CONSECUTIVE_FAILURE_THRESHOLD) {
    if (currentSite.active) {
      db.prepare("UPDATE sites SET active = 0 WHERE id = ?").run(site.id);
      console.log(`  [${site.domain}] AUTO-PAUSED after ${currentSite.consecutive_failures} failures`);
    }
    return;
  }

  currentScanSite = site.domain;
  const pagesToScan = Math.min(PAGES_PER_SITE, pages.length);
  const shuffled = [...pages].sort(() => Math.random() - 0.5);
  const selectedPages = shuffled.slice(0, pagesToScan);

  let gotAnyData = false;

  for (const pagePath of selectedPages) {
    const fullUrl = `https://${site.domain}${pagePath}`;
    console.log(`  [${site.name || site.domain}] ${fullUrl}`);

    let rawData = await scanPage(browser, site, fullUrl);

    // Retry once on failure
    if (!rawData) {
      await new Promise(r => setTimeout(r, 2000));
      rawData = await scanPage(browser, site, fullUrl);
    }

    if (rawData) {
      storeScanData(site.id, rawData);
      if (rawData.allBids.length > 0 || rawData.prebidDetected) gotAnyData = true;
      console.log(`    → Prebid: ${rawData.prebidDetected}, Bids: ${rawData.allBids.length}, NoBids: ${rawData.noBids.length}`);
    } else {
      console.log(`    → Failed`);
    }

    lastScanActivity = Date.now();
  }

  // Update site status
  if (gotAnyData) {
    db.prepare("UPDATE sites SET last_scanned = ?, consecutive_failures = 0 WHERE id = ?")
      .run(new Date().toISOString(), site.id);
  } else {
    db.prepare("UPDATE sites SET last_scanned = ?, consecutive_failures = consecutive_failures + 1 WHERE id = ?")
      .run(new Date().toISOString(), site.id);
    const updated = db.prepare("SELECT consecutive_failures FROM sites WHERE id = ?").get(site.id);
    if (updated && updated.consecutive_failures >= CONSECUTIVE_FAILURE_THRESHOLD) {
      db.prepare("UPDATE sites SET active = 0 WHERE id = ?").run(site.id);
      console.log(`  [${site.domain}] AUTO-PAUSED after ${updated.consecutive_failures} consecutive failures`);
      db.prepare("INSERT INTO alerts (scan_id, site_id, timestamp, severity, message) VALUES (0, ?, ?, ?, ?)")
        .run(site.id, new Date().toISOString(), "CRITICAL", `Auto-paused after ${updated.consecutive_failures} failures`);
    }
  }
}

async function runScanCycle() {
  if (isScanning) return;
  isScanning = true;
  lastScanActivity = Date.now();

  const heartbeat = setInterval(() => {
    console.log(`  💓 Heartbeat: scanning ${currentScanSite || 'unknown'}, last activity ${Math.round((Date.now() - lastScanActivity) / 1000)}s ago`);
  }, 60000);

  const sites = db.prepare("SELECT * FROM sites WHERE active = 1").all();
  console.log(`\n[${new Date().toISOString()}] Scan cycle v24: ${sites.length} active sites`);

  let browser;
  let sitesScanned = 0;
  const RECYCLE_EVERY = 10;

  try {
    for (let i = 0; i < sites.length; i++) {
      if (!browser || sitesScanned >= RECYCLE_EVERY) {
        if (browser) {
          try { await browser.close(); } catch(e) {}
          killOrphanedChromium();
          await new Promise(r => setTimeout(r, 500));
        }
        try {
          browser = await puppeteer.launch({
            headless: "new",
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
            protocolTimeout: 60000,
            args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--single-process", "--max-old-space-size=256"],
          });
          sitesScanned = 0;
        } catch(launchErr) {
          console.error(`  🔴 Browser launch failed: ${launchErr.message}`);
          killOrphanedChromium();
          await new Promise(r => setTimeout(r, 2000));
          try {
            browser = await puppeteer.launch({
              headless: "new",
              executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
              protocolTimeout: 60000,
              args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--single-process", "--max-old-space-size=256"],
            });
            sitesScanned = 0;
          } catch(e2) {
            console.error(`  🔴 Browser re-launch failed, skipping remaining sites: ${e2.message}`);
            break;
          }
        }
      }

      try {
        await Promise.race([
          scanSite(browser, sites[i]),
          new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 90000)),
        ]);
      } catch(e) {
        console.log(`  [${sites[i].domain}] Timed out`);
        try { await browser.close(); } catch(e2) {}
        browser = null;
        killOrphanedChromium();
      }
      sitesScanned++;
      lastScanActivity = Date.now();
    }
  } catch(e) {
    console.error("🔴 Scan cycle error:", e.message);
  } finally {
    clearInterval(heartbeat);
    if (browser) { try { await browser.close(); } catch(e) {} }
    killOrphanedChromium();
    lastScanTime = new Date().toISOString();
    isScanning = false;
    currentScanSite = null;
    console.log(`  ✅ Cycle complete at ${lastScanTime}\n`);
  }
}

// Health watchdog — 3 min timeout with chromium cleanup
setInterval(() => {
  if (isScanning && (Date.now() - lastScanActivity > 3 * 60 * 1000)) {
    console.log(`\n⚠️ [Watchdog] Scan stuck for 3+ minutes, forcing reset`);
    isScanning = false;
    currentScanSite = null;
    killOrphanedChromium();
  }
}, 15000);

// =============================================================================
// MIDDLEWARE
// =============================================================================
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// Basic auth
const AUTH_USER = process.env.AUTH_USER;
const AUTH_PASS = process.env.AUTH_PASS;
if (AUTH_USER && AUTH_PASS) {
  app.use((req, res, next) => {
    if (req.path === "/api/health") return next();
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith("Basic ")) {
      res.setHeader("WWW-Authenticate", 'Basic realm="Prebid Monitor"');
      return res.status(401).send("Authentication required");
    }
    const [user, pass] = Buffer.from(auth.split(" ")[1], "base64").toString().split(":");
    if (user === AUTH_USER && pass === AUTH_PASS) return next();
    res.setHeader("WWW-Authenticate", 'Basic realm="Prebid Monitor"');
    return res.status(401).send("Invalid credentials");
  });
}

// =============================================================================
// API: HEALTH
// =============================================================================
app.get("/api/health", (req, res) => {
  const sites = db.prepare("SELECT COUNT(*) as c FROM sites WHERE active = 1").get();
  const mem = process.memoryUsage();
  res.json({
    status: "ok", version: "v24",
    active_sites: sites.c, is_scanning: isScanning,
    current_scan_site: currentScanSite,
    last_scan: lastScanTime,
    last_activity_ago_sec: Math.round((Date.now() - lastScanActivity) / 1000),
    scan_interval_min: scanIntervalMs / 60000,
    memory_mb: Math.round(mem.rss / 1024 / 1024),
    heap_mb: Math.round(mem.heapUsed / 1024 / 1024),
  });
});

// =============================================================================
// API: SITES
// =============================================================================
app.get("/api/sites", (req, res) => {
  const hours = parseInt(req.query.hours) || 24;
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const sites = db.prepare("SELECT * FROM sites ORDER BY active DESC, name ASC").all();

  const result = sites.map(s => {
    const stats = db.prepare(`
      SELECT COUNT(*) as total_scans, SUM(total_bids) as total_bids,
        SUM(total_wins) as total_wins, AVG(avg_winning_cpm) as avg_cpm,
        AVG(avg_latency) as avg_latency
      FROM scans WHERE site_id = ? AND timestamp >= ?
    `).get(s.id, since);
    const bidders = db.prepare(`
      SELECT COUNT(DISTINCT bidder) as count FROM bids WHERE site_id = ? AND timestamp >= ?
    `).get(s.id, since);

    return { ...s, stats_24h: { ...stats, unique_bidders: bidders.count } };
  });

  res.json(result);
});

app.post("/api/sites", (req, res) => {
  const { domain, name, pages } = req.body;
  if (!domain) return res.status(400).json({ error: "domain required" });
  try {
    const r = db.prepare("INSERT INTO sites (domain, name, pages_json) VALUES (?, ?, ?)")
      .run(domain, name || null, JSON.stringify(pages || ["/"]));
    res.json({ success: true, id: r.lastInsertRowid });
  } catch(e) {
    res.status(400).json({ error: e.message });
  }
});

app.put("/api/sites/:id", (req, res) => {
  const { name, pages, active } = req.body;
  if (name !== undefined) db.prepare("UPDATE sites SET name = ? WHERE id = ?").run(name, req.params.id);
  if (pages !== undefined) db.prepare("UPDATE sites SET pages_json = ? WHERE id = ?").run(JSON.stringify(pages), req.params.id);
  if (active !== undefined) {
    db.prepare("UPDATE sites SET active = ? WHERE id = ?").run(active ? 1 : 0, req.params.id);
    if (active) db.prepare("UPDATE sites SET consecutive_failures = 0 WHERE id = ?").run(req.params.id);
  }
  res.json({ success: true });
});

app.delete("/api/sites/:id", (req, res) => {
  const id = req.params.id;
  db.prepare("DELETE FROM bids WHERE site_id = ?").run(id);
  db.prepare("DELETE FROM no_bids WHERE site_id = ?").run(id);
  db.prepare("DELETE FROM alerts WHERE site_id = ?").run(id);
  db.prepare("DELETE FROM scans WHERE site_id = ?").run(id);
  db.prepare("DELETE FROM sites WHERE id = ?").run(id);
  res.json({ success: true });
});

app.post("/api/sites/:id/unpause", (req, res) => {
  db.prepare("UPDATE sites SET consecutive_failures = 0, active = 1 WHERE id = ?").run(req.params.id);
  res.json({ success: true, status: "active" });
});

// =============================================================================
// API: OVERVIEW
// =============================================================================
app.get("/api/overview", (req, res) => {
  const hours = parseInt(req.query.hours) || 24;
  const siteId = req.query.site_id || null;
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const sf = siteId ? "AND site_id = ?" : "";
  const bf = siteId ? "AND b.site_id = ?" : "";
  const params = siteId ? [since, parseInt(siteId)] : [since];

  const stats = db.prepare(`
    SELECT COUNT(*) as total_scans, SUM(total_bids) as total_bids,
      SUM(total_wins) as total_wins, SUM(total_no_bids) as total_no_bids,
      AVG(CASE WHEN avg_winning_cpm > 0 THEN avg_winning_cpm END) as avg_winning_cpm,
      AVG(avg_latency) as avg_latency
    FROM scans WHERE timestamp >= ? ${sf}
  `).get(...params);

  const uniqueBidders = db.prepare(`SELECT COUNT(DISTINCT bidder) as count FROM bids b WHERE timestamp >= ? ${bf}`).get(...params);
  const alltimeBidders = db.prepare(`SELECT COUNT(DISTINCT bidder) as count FROM bids`).get();

  res.json({
    ...stats,
    unique_bidders: uniqueBidders.count,
    unique_bidders_alltime: alltimeBidders.count,
    is_scanning: isScanning,
    current_scan_site: currentScanSite,
    last_scan_time: lastScanTime,
    scan_interval_min: scanIntervalMs / 60000,
    auto_scan_enabled: autoScanEnabled,
  });
});

// =============================================================================
// API: ALERTS
// =============================================================================
app.get("/api/alerts", (req, res) => {
  const hours = parseInt(req.query.hours) || 24;
  const siteId = req.query.site_id || null;
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const f = siteId ? "AND a.site_id = ?" : "";
  const params = siteId ? [since, parseInt(siteId)] : [since];

  const alerts = db.prepare(`
    SELECT a.*, s.domain as site_domain FROM alerts a
    LEFT JOIN sites s ON a.site_id = s.id
    WHERE a.timestamp >= ? ${f}
    ORDER BY a.timestamp DESC LIMIT 30
  `).all(...params);
  res.json(alerts);
});

// =============================================================================
// API: CPM TREND
// =============================================================================
app.get("/api/cpm-trend", (req, res) => {
  const hours = parseInt(req.query.hours) || 24;
  const siteId = req.query.site_id || null;
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const f = siteId ? "AND site_id = ?" : "";
  const params = siteId ? [since, parseInt(siteId)] : [since];

  const rows = db.prepare(`
    SELECT timestamp, avg_winning_cpm, total_bids, total_wins, total_no_bids
    FROM scans WHERE timestamp >= ? ${f} ORDER BY timestamp ASC
  `).all(...params);
  res.json(rows);
});

// =============================================================================
// API: BIDDERS
// =============================================================================
app.get("/api/bidders", (req, res) => {
  const hours = parseInt(req.query.hours) || 24;
  const siteId = req.query.site_id || null;
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const f = siteId ? "AND b.site_id = ?" : "";
  const params = siteId ? [since, parseInt(siteId)] : [since];

  const rows = db.prepare(`
    SELECT b.bidder, COUNT(*) as total_bids, SUM(b.is_winner) as wins,
      AVG(b.cpm) as avg_cpm, MAX(b.cpm) as max_cpm,
      AVG(b.time_to_respond) as avg_latency,
      COUNT(DISTINCT b.ad_unit_code) as ad_units
    FROM bids b WHERE b.timestamp >= ? ${f}
    GROUP BY b.bidder ORDER BY total_bids DESC
  `).all(...params);
  res.json(rows);
});

// =============================================================================
// API: AD UNITS
// =============================================================================
app.get("/api/ad-units", (req, res) => {
  const hours = parseInt(req.query.hours) || 24;
  const siteId = req.query.site_id || null;
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const f = siteId ? "AND b.site_id = ?" : "";
  const params = siteId ? [since, parseInt(siteId)] : [since];

  const rows = db.prepare(`
    SELECT b.ad_unit_code, COUNT(*) as total_bids,
      COUNT(DISTINCT b.bidder) as unique_bidders,
      AVG(b.cpm) as avg_cpm, AVG(b.time_to_respond) as avg_latency,
      s.domain as site
    FROM bids b LEFT JOIN sites s ON b.site_id = s.id
    WHERE b.timestamp >= ? ${f}
    GROUP BY b.ad_unit_code ORDER BY total_bids DESC
  `).all(...params);
  res.json(rows);
});

// =============================================================================
// API: LATENCY
// =============================================================================
app.get("/api/latency", (req, res) => {
  const hours = parseInt(req.query.hours) || 24;
  const siteId = req.query.site_id || null;
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const f = siteId ? "AND b.site_id = ?" : "";
  const params = siteId ? [since, parseInt(siteId)] : [since];

  const rows = db.prepare(`
    SELECT time_to_respond FROM bids b
    WHERE timestamp >= ? AND time_to_respond IS NOT NULL ${f}
  `).all(...params);

  const buckets = { "0-200ms": 0, "200-500ms": 0, "500-1000ms": 0, "1000-1500ms": 0, "1500-2000ms": 0, "2000ms+": 0 };
  rows.forEach(r => {
    const t = r.time_to_respond;
    if (t < 200) buckets["0-200ms"]++;
    else if (t < 500) buckets["200-500ms"]++;
    else if (t < 1000) buckets["500-1000ms"]++;
    else if (t < 1500) buckets["1000-1500ms"]++;
    else if (t < 2000) buckets["1500-2000ms"]++;
    else buckets["2000ms+"]++;
  });
  res.json({ distribution: buckets, total: rows.length });
});

// =============================================================================
// API: NO-BIDS
// =============================================================================
app.get("/api/no-bids", (req, res) => {
  const hours = parseInt(req.query.hours) || 24;
  const siteId = req.query.site_id || null;
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const f = siteId ? "AND nb.site_id = ?" : "";
  const params = siteId ? [since, parseInt(siteId)] : [since];

  const rows = db.prepare(`
    SELECT nb.bidder, COUNT(*) as no_bid_count,
      COUNT(DISTINCT nb.ad_unit_code) as ad_units_affected,
      st.domain as site
    FROM no_bids nb LEFT JOIN sites st ON nb.site_id = st.id
    WHERE nb.timestamp >= ? ${f}
    GROUP BY nb.bidder, st.domain ORDER BY no_bid_count DESC
  `).all(...params);
  res.json(rows);
});

// =============================================================================
// API: COMPARE
// =============================================================================
app.get("/api/compare", (req, res) => {
  const hours = parseInt(req.query.hours) || 24;
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const rows = db.prepare(`
    SELECT s.site_id, st.domain, st.name,
      COUNT(*) as total_scans,
      AVG(s.avg_winning_cpm) as avg_cpm,
      SUM(s.total_bids) as total_bids,
      SUM(s.total_wins) as total_wins,
      AVG(s.avg_latency) as avg_latency
    FROM scans s JOIN sites st ON s.site_id = st.id
    WHERE s.timestamp >= ?
    GROUP BY s.site_id ORDER BY avg_cpm DESC
  `).all(since);
  res.json(rows);
});

// =============================================================================
// API: BIDDER MATRIX
// =============================================================================
app.get("/api/bidder-matrix", (req, res) => {
  const hours = parseInt(req.query.hours) || 24;
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const rows = db.prepare(`
    SELECT b.bidder, st.domain,
      COUNT(*) as bid_count, AVG(b.cpm) as avg_cpm, SUM(b.is_winner) as wins
    FROM bids b JOIN sites st ON b.site_id = st.id
    WHERE b.timestamp >= ?
    GROUP BY b.bidder, st.domain ORDER BY b.bidder, st.domain
  `).all(since);
  res.json(rows);
});

// =============================================================================
// API: DRILLDOWN BIDS (was missing in v22)
// =============================================================================
app.get("/api/drilldown/bids", (req, res) => {
  const hours = parseInt(req.query.hours) || 24;
  const siteId = req.query.site_id || null;
  const bidder = req.query.bidder || null;
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  let filters = "WHERE b.timestamp >= ?";
  let params = [since];

  if (siteId) { filters += " AND b.site_id = ?"; params.push(parseInt(siteId)); }
  if (bidder) { filters += " AND b.bidder = ?"; params.push(bidder); }

  const rows = db.prepare(`
    SELECT b.*, st.domain, st.name as site_name
    FROM bids b LEFT JOIN sites st ON b.site_id = st.id
    ${filters}
    ORDER BY b.timestamp DESC LIMIT 5000
  `).all(...params);
  res.json(rows);
});

// =============================================================================
// API: STATS (was missing in v22)
// =============================================================================
app.get("/api/stats", (req, res) => {
  const totalBids = db.prepare("SELECT COUNT(*) as c FROM bids").get().c;
  const totalScans = db.prepare("SELECT COUNT(*) as c FROM scans").get().c;
  const totalNoBids = db.prepare("SELECT COUNT(*) as c FROM no_bids").get().c;
  const totalSites = db.prepare("SELECT COUNT(*) as c FROM sites").get().c;
  const activeSites = db.prepare("SELECT COUNT(*) as c FROM sites WHERE active = 1").get().c;
  const uniqueBidders = db.prepare("SELECT COUNT(DISTINCT bidder) as c FROM bids").get().c;

  res.json({
    total_bids: totalBids,
    total_scans: totalScans,
    total_no_bids: totalNoBids,
    total_sites: totalSites,
    active_sites: activeSites,
    unique_bidders_alltime: uniqueBidders,
    is_scanning: isScanning,
    last_scan: lastScanTime,
  });
});

// =============================================================================
// API: ALL-TIME BIDDERS (never lose bidders from paused sites)
// =============================================================================
app.get("/api/bidders-alltime", (req, res) => {
  const rows = db.prepare(`
    SELECT b.bidder,
      COUNT(*) as total_bids,
      SUM(b.is_winner) as wins,
      AVG(b.cpm) as avg_cpm,
      MAX(b.cpm) as max_cpm,
      AVG(b.time_to_respond) as avg_latency,
      COUNT(DISTINCT b.ad_unit_code) as ad_units,
      COUNT(DISTINCT b.site_id) as sites_seen,
      MIN(b.timestamp) as first_seen,
      MAX(b.timestamp) as last_seen
    FROM bids b
    GROUP BY b.bidder ORDER BY total_bids DESC
  `).all();
  res.json(rows);
});

// =============================================================================
// API: SCAN CONTROLS
// =============================================================================
app.post("/api/scan", async (req, res) => {
  if (isScanning) {
    const staleMins = Math.round((Date.now() - lastScanActivity) / 60000);
    if (staleMins >= 3) {
      console.log(`\n⚠️ /api/scan: Scanner stuck for ${staleMins}min, force-resetting`);
      isScanning = false;
      currentScanSite = null;
      killOrphanedChromium();
      await new Promise(r => setTimeout(r, 1000));
      res.json({ status: "force_restarted", stale_minutes: staleMins });
      runScanCycle();
      return;
    }
    return res.json({ status: "already_running", current_site: currentScanSite, activity_ago_sec: Math.round((Date.now() - lastScanActivity) / 1000) });
  }
  res.json({ status: "started" });
  runScanCycle();
});

app.post("/api/scan/pause", (req, res) => {
  autoScanEnabled = false;
  res.json({ auto_scan_enabled: false });
});

app.post("/api/scan/resume", (req, res) => {
  autoScanEnabled = true;
  res.json({ auto_scan_enabled: true });
});

app.post("/api/config", (req, res) => {
  const { interval_min } = req.body;
  if (interval_min && interval_min >= 1 && interval_min <= 60) {
    scanIntervalMs = interval_min * 60 * 1000;
    if (scanTimer) clearInterval(scanTimer);
    scanTimer = setInterval(() => { if (autoScanEnabled) runScanCycle(); }, scanIntervalMs);
    res.json({ scan_interval_min: interval_min });
  } else {
    res.status(400).json({ error: "interval_min must be 1-60" });
  }
});

// =============================================================================
// API: EXPORT CSV
// =============================================================================
app.get("/api/export/csv", (req, res) => {
  const hours = parseInt(req.query.hours) || 24;
  const siteId = req.query.site_id || null;
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const f = siteId ? "AND b.site_id = ?" : "";
  const params = siteId ? [since, parseInt(siteId)] : [since];

  const rows = db.prepare(`
    SELECT b.timestamp, st.domain, b.bidder, b.ad_unit_code, b.cpm, b.currency,
      b.width, b.height, b.time_to_respond, b.media_type, b.is_winner
    FROM bids b JOIN sites st ON b.site_id = st.id
    WHERE b.timestamp >= ? ${f} ORDER BY b.timestamp DESC
  `).all(...params);

  const header = "timestamp,domain,bidder,ad_unit,cpm,currency,width,height,latency_ms,media_type,is_winner\n";
  const csv = header + rows.map(r =>
    `${r.timestamp},${r.domain},${r.bidder},${r.ad_unit_code},${r.cpm},${r.currency},${r.width},${r.height},${r.time_to_respond},${r.media_type},${r.is_winner}`
  ).join("\n");

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=prebid-export.csv");
  res.send(csv);
});

// =============================================================================
// API: CLEANUP
// =============================================================================
app.post("/api/cleanup", (req, res) => {
  const days = parseInt(req.body.days) || 7;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const b = db.prepare("DELETE FROM bids WHERE timestamp < ?").run(cutoff);
  const n = db.prepare("DELETE FROM no_bids WHERE timestamp < ?").run(cutoff);
  const a = db.prepare("DELETE FROM alerts WHERE timestamp < ?").run(cutoff);
  const s = db.prepare("DELETE FROM scans WHERE timestamp < ?").run(cutoff);
  db.exec("VACUUM");
  res.json({ deleted: { bids: b.changes, no_bids: n.changes, alerts: a.changes, scans: s.changes } });
});

// =============================================================================
// API: FLOORS
// =============================================================================
app.get("/api/floors/:siteId", (req, res) => {
  const row = db.prepare(`
    SELECT floor_config_json, ad_server_targeting_json, configured_bidders_json, bidder_timeout
    FROM scans WHERE site_id = ? AND floor_config_json IS NOT NULL
    ORDER BY timestamp DESC LIMIT 1
  `).get(req.params.siteId);
  if (!row) return res.json({ floors: null, targeting: null, bidders: [], timeout: null });
  res.json({
    floors: JSON.parse(row.floor_config_json || "null"),
    targeting: JSON.parse(row.ad_server_targeting_json || "null"),
    bidders: JSON.parse(row.configured_bidders_json || "[]"),
    timeout: row.bidder_timeout,
  });
});

// =============================================================================
// AUTO-CLEANUP
// =============================================================================
function autoCleanup() {
  const RETENTION_DAYS = 7;
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  try {
    const b = db.prepare("DELETE FROM bids WHERE timestamp < ?").run(cutoff);
    const n = db.prepare("DELETE FROM no_bids WHERE timestamp < ?").run(cutoff);
    const a = db.prepare("DELETE FROM alerts WHERE timestamp < ?").run(cutoff);
    const s = db.prepare("DELETE FROM scans WHERE timestamp < ?").run(cutoff);
    db.exec("VACUUM");
    console.log(`[Auto-Cleanup] Deleted data older than ${RETENTION_DAYS}d: ${b.changes} bids, ${n.changes} no-bids, ${a.changes} alerts, ${s.changes} scans`);
  } catch(e) {
    console.error("[Auto-Cleanup] Error:", e.message);
  }
}

// =============================================================================
// START
// =============================================================================
app.listen(PORT, () => {
  const sites = db.prepare("SELECT COUNT(*) as c FROM sites WHERE active = 1").get();
  const total = db.prepare("SELECT COUNT(*) as c FROM sites").get();
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  Prebid Monitor v24 (hardened)`);
  console.log(`  Running at: http://localhost:${PORT}`);
  console.log(`  Active sites: ${sites.c} / ${total.c} total`);
  console.log(`  Scan interval: ${scanIntervalMs / 60000} minutes`);
  console.log(`  Watchdog: 3min | Browser recycle: every 10 sites`);
  console.log(`${"=".repeat(60)}\n`);

  setTimeout(runScanCycle, 10000);
  scanTimer = setInterval(() => { if (autoScanEnabled) runScanCycle(); }, scanIntervalMs);

  // Auto-cleanup on boot and every 2 hours
  setTimeout(autoCleanup, 30000);
  setInterval(autoCleanup, 2 * 60 * 60 * 1000);
});
