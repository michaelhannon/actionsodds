/**
 * Action's Odds — GeoIP Lookups (Phase 2a)
 *
 * Reads MaxMind GeoLite2 databases to map IP addresses to:
 *   - Country / region / city
 *   - Coordinates (lat/lon) for distance + velocity calculations
 *   - ASN (autonomous system / network operator) for sharing detection
 *
 * The DB files (~80MB) are NOT committed to the repo. They're downloaded
 * on Railway boot via scripts/download-geoip.js using MAXMIND_LICENSE_KEY.
 *
 * If the DB files aren't present, lookups return all-null instead of crashing.
 * That keeps the server bootable even if the GeoIP setup hasn't run yet.
 */

const fs = require('fs');
const path = require('path');

const CITY_DB_PATH =
  process.env.GEOIP_DB_PATH || path.join(__dirname, '..', 'data', 'GeoLite2-City.mmdb');
const ASN_DB_PATH =
  process.env.GEOIP_ASN_DB_PATH || path.join(__dirname, '..', 'data', 'GeoLite2-ASN.mmdb');

let cityReader = null;
let asnReader = null;
let initStarted = false;

function init() {
  if (initStarted) return;
  initStarted = true;

  if (!fs.existsSync(CITY_DB_PATH) || !fs.existsSync(ASN_DB_PATH)) {
    console.warn(
      '[geoip] MaxMind DB files missing — geolocation disabled.\n' +
        '         Run: node scripts/download-geoip.js'
    );
    return;
  }

  // Lazy-require so a missing maxmind dep doesn't crash boot
  let maxmind;
  try {
    maxmind = require('maxmind');
  } catch (err) {
    console.warn('[geoip] maxmind npm package not installed — geolocation disabled.');
    return;
  }

  maxmind
    .open(CITY_DB_PATH)
    .then((r) => {
      cityReader = r;
      console.log('[geoip] City DB loaded');
    })
    .catch((err) => console.warn('[geoip] City DB load failed:', err.message));

  maxmind
    .open(ASN_DB_PATH)
    .then((r) => {
      asnReader = r;
      console.log('[geoip] ASN DB loaded');
    })
    .catch((err) => console.warn('[geoip] ASN DB load failed:', err.message));
}

/**
 * Look up an IP. Returns shape:
 *   { country, region, city, asn, asn_org, lat, lon }
 * with all fields possibly null.
 */
function lookup(ip) {
  init();
  const result = {
    country: null,
    region: null,
    city: null,
    asn: null,
    asn_org: null,
    lat: null,
    lon: null,
  };

  if (!ip || ip === '127.0.0.1' || ip === '::1' || ip.startsWith('10.') || ip.startsWith('192.168.')) {
    return result;
  }

  try {
    if (cityReader) {
      const city = cityReader.get(ip);
      if (city) {
        result.country = city.country?.iso_code || null;
        result.region = city.subdivisions?.[0]?.iso_code || null;
        result.city = city.city?.names?.en || null;
        result.lat = city.location?.latitude ?? null;
        result.lon = city.location?.longitude ?? null;
      }
    }
    if (asnReader) {
      const asn = asnReader.get(ip);
      if (asn) {
        result.asn = asn.autonomous_system_number ? `AS${asn.autonomous_system_number}` : null;
        result.asn_org = asn.autonomous_system_organization || null;
      }
    }
  } catch (err) {
    console.warn('[geoip] lookup failed for', ip, '-', err.message);
  }

  return result;
}

/**
 * Pull the real client IP from a request, handling Railway's proxy +
 * Cloudflare headers. Falls back to socket address if nothing else available.
 *
 * Order of preference:
 *   1. Cloudflare's CF-Connecting-IP
 *   2. X-Real-IP
 *   3. First entry in X-Forwarded-For
 *   4. socket.remoteAddress
 */
function getClientIp(req) {
  return (
    req.headers['cf-connecting-ip'] ||
    req.headers['x-real-ip'] ||
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    null
  );
}

/**
 * Haversine formula — distance in km between two lat/lon coordinates.
 * Used by the velocity check to detect impossible travel.
 */
function distanceKm(lat1, lon1, lat2, lon2) {
  if ([lat1, lon1, lat2, lon2].some((v) => v == null)) return null;
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

module.exports = { lookup, getClientIp, distanceKm };
