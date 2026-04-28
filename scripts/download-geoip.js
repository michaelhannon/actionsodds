/**
 * Action's Odds — GeoIP Database Downloader
 *
 * Fetches MaxMind GeoLite2 City + ASN databases (~80MB total) into ./data/
 * Run on Railway boot (or via cron weekly to keep DBs fresh).
 *
 * Requires: MAXMIND_LICENSE_KEY env var
 *
 * Idempotent: if files already exist and were downloaded recently, skips.
 *
 * Usage:
 *   node scripts/download-geoip.js          # run once
 *   node scripts/download-geoip.js --force  # ignore freshness check
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const LICENSE_KEY = process.env.MAXMIND_LICENSE_KEY;
const DATA_DIR = path.join(__dirname, '..', 'data');
const FORCE = process.argv.includes('--force');
const FRESHNESS_DAYS = 7;

if (!LICENSE_KEY) {
  console.error('[geoip] MAXMIND_LICENSE_KEY not set in env. Skipping download.');
  console.error('         Set it in Railway Variables and redeploy.');
  // Exit 0 so this doesn't break the boot. The geoip module handles the missing-DB case.
  process.exit(0);
}

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const editions = [
  { name: 'GeoLite2-City', file: 'GeoLite2-City.mmdb' },
  { name: 'GeoLite2-ASN', file: 'GeoLite2-ASN.mmdb' },
];

function isFresh(filePath) {
  if (!fs.existsSync(filePath)) return false;
  const ageMs = Date.now() - fs.statSync(filePath).mtimeMs;
  return ageMs < FRESHNESS_DAYS * 24 * 60 * 60 * 1000;
}

function fetchToFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https
      .get(url, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          file.close();
          fs.unlinkSync(dest);
          return fetchToFile(res.headers.location, dest).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          file.close();
          fs.unlinkSync(dest);
          return reject(new Error(`HTTP ${res.statusCode} from ${url.split('?')[0]}`));
        }
        res.pipe(file).on('finish', () => file.close(resolve));
      })
      .on('error', (err) => {
        file.close();
        try { fs.unlinkSync(dest); } catch {}
        reject(err);
      });
  });
}

(async () => {
  for (const ed of editions) {
    const finalPath = path.join(DATA_DIR, ed.file);

    if (!FORCE && isFresh(finalPath)) {
      console.log(`[geoip] ${ed.file} is fresh (<${FRESHNESS_DAYS}d old) — skipping`);
      continue;
    }

    const url = `https://download.maxmind.com/app/geoip_download?edition_id=${ed.name}&license_key=${LICENSE_KEY}&suffix=tar.gz`;
    const tarPath = path.join(DATA_DIR, `${ed.name}.tar.gz`);

    try {
      console.log(`[geoip] Downloading ${ed.name}...`);
      await fetchToFile(url, tarPath);

      console.log(`[geoip] Extracting ${ed.name}...`);
      execSync(`tar -xzf ${tarPath} -C ${DATA_DIR}`);

      // Move .mmdb out of the versioned subdir MaxMind creates
      const dirs = fs.readdirSync(DATA_DIR).filter(
        (d) =>
          d.startsWith(ed.name + '_') &&
          fs.statSync(path.join(DATA_DIR, d)).isDirectory()
      );
      if (dirs.length) {
        fs.copyFileSync(path.join(DATA_DIR, dirs[0], ed.file), finalPath);
        fs.rmSync(path.join(DATA_DIR, dirs[0]), { recursive: true, force: true });
      }
      try { fs.unlinkSync(tarPath); } catch {}
      console.log(`[geoip] ✓ ${ed.file} ready`);
    } catch (err) {
      console.error(`[geoip] FAILED ${ed.name}:`, err.message);
      // Don't crash the boot — geoip module degrades gracefully
    }
  }
  console.log('[geoip] Download script complete');
})();
