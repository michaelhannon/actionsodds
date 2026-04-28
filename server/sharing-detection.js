/**
 * Action's Odds — Sharing Detection (Phase 2a)
 *
 * Three detection layers:
 *
 *   1. checkVelocity(): real-time, called on every login. Compares the new
 *      login's location against the last 10 successful logins. If any pair
 *      would require flying faster than a commercial jet (~1000 km/h),
 *      we treat it as impossible and lock the account.
 *
 *   2. analyzeMultiGeo(): batch, called by the cron. Counts distinct
 *      regions/ASNs over a 14-day window. 3+ regions = flag.
 *
 *   3. analyzeConcurrentUse(): batch, called by the cron. Looks at
 *      currently-active sessions. If 2+ sessions from different ASN/region
 *      buckets are both seen-recently, that's the strongest sharing signal.
 *
 * Threshold tuning lives at the top of this file. Start conservative,
 * adjust based on what you see in the sharing_flags table.
 */

const { distanceKm } = require('./geoip');
const { supabaseAdmin } = require('./auth');

// ─── Tunable thresholds ────────────────────────────────────────────────────
const VELOCITY_KMPH = 1000;          // commercial jet cruising speed
const VELOCITY_MIN_DISTANCE_KM = 500; // ignore short hops (same metro area)
const MULTI_GEO_LOOKBACK_DAYS = 14;
const MULTI_GEO_THRESHOLD_REGIONS = 3;

/**
 * Compare the new login location to the last 10 successful logins.
 * Returns { isImpossible, evidence } — caller should lock the account
 * and email the user when isImpossible is true.
 */
async function checkVelocity({ userId, newIp, newLat, newLon, newCity, newCountry }) {
  if (newLat == null || newLon == null) return { isImpossible: false };

  const { data: recent } = await supabaseAdmin
    .from('login_events')
    .select('ip_city, ip_country, ip_address, metadata, created_at')
    .eq('user_id', userId)
    .eq('event_type', 'login_success')
    .order('created_at', { ascending: false })
    .limit(10);

  if (!recent || recent.length === 0) return { isImpossible: false };

  for (const event of recent) {
    const lat = event.metadata?.lat;
    const lon = event.metadata?.lon;
    if (lat == null || lon == null) continue;
    if (event.ip_address === newIp) continue;

    const km = distanceKm(lat, lon, newLat, newLon);
    if (km == null || km < VELOCITY_MIN_DISTANCE_KM) continue;

    const minutesAgo = (Date.now() - new Date(event.created_at).getTime()) / 60000;
    if (minutesAgo <= 0) continue;

    const requiredKmph = (km / minutesAgo) * 60;

    if (requiredKmph > VELOCITY_KMPH) {
      return {
        isImpossible: true,
        evidence: {
          locationA: `${event.ip_city || '?'}, ${event.ip_country || '?'}`,
          locationB: `${newCity || '?'}, ${newCountry || '?'}`,
          distanceKm: Math.round(km),
          minutesBetween: Math.round(minutesAgo),
          requiredKmph: Math.round(requiredKmph),
          previousEventAt: event.created_at,
        },
      };
    }
  }

  return { isImpossible: false };
}

/**
 * Count distinct regions / ASNs / cities over the lookback window.
 * Heuristic flag — 3+ distinct (country, region) pairs = likely sharing.
 *
 * Returns null if no flag. Returns { flag_type, severity, evidence } if flagged.
 */
async function analyzeMultiGeo(userId) {
  const since = new Date(
    Date.now() - MULTI_GEO_LOOKBACK_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  const { data: events } = await supabaseAdmin
    .from('login_events')
    .select('ip_country, ip_region, ip_city, ip_asn, created_at')
    .eq('user_id', userId)
    .eq('event_type', 'login_success')
    .gte('created_at', since);

  if (!events) return null;

  const regions = new Set();
  const asns = new Set();
  const cities = new Set();
  for (const e of events) {
    if (e.ip_region && e.ip_country) regions.add(`${e.ip_country}/${e.ip_region}`);
    if (e.ip_asn) asns.add(e.ip_asn);
    if (e.ip_city) cities.add(e.ip_city);
  }

  if (regions.size >= MULTI_GEO_THRESHOLD_REGIONS) {
    return {
      flag_type: 'multiple_geos',
      severity: regions.size >= 5 ? 'high' : 'medium',
      evidence: {
        distinctRegions: Array.from(regions),
        distinctAsns: Array.from(asns),
        distinctCities: Array.from(cities),
        loginCount: events.length,
        windowDays: MULTI_GEO_LOOKBACK_DAYS,
      },
    };
  }

  return null;
}

/**
 * Look at currently-active sessions for a user. If 2+ sessions are seen-recently
 * from different ASN+region buckets, that's the strongest sharing signal — they
 * are *actively* using the account from different networks at the same time.
 */
async function analyzeConcurrentUse(userId) {
  const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();

  const { data: sessions } = await supabaseAdmin
    .from('user_sessions')
    .select('id, ip_address, ip_city, ip_region, ip_country, ip_asn, last_seen_at, device_name')
    .eq('user_id', userId)
    .is('revoked_at', null)
    .gte('last_seen_at', fifteenMinAgo);

  if (!sessions || sessions.length < 2) return null;

  const buckets = new Map();
  for (const s of sessions) {
    const key = `${s.ip_asn || 'unknown'}|${s.ip_country || ''}|${s.ip_region || ''}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(s);
  }

  if (buckets.size >= 2) {
    return {
      flag_type: 'concurrent_distinct_use',
      severity: 'high',
      evidence: {
        bucketCount: buckets.size,
        sessions: sessions.map((s) => ({
          device: s.device_name,
          location: `${s.ip_city || '?'}, ${s.ip_region || '?'}`,
          asn: s.ip_asn,
          lastSeen: s.last_seen_at,
        })),
      },
    };
  }

  return null;
}

/**
 * Persist a flag for admin review.
 */
async function recordFlag(userId, flag) {
  if (!flag) return;
  await supabaseAdmin.from('sharing_flags').insert({
    user_id: userId,
    flag_type: flag.flag_type,
    severity: flag.severity,
    evidence: flag.evidence,
  });
}

module.exports = { checkVelocity, analyzeMultiGeo, analyzeConcurrentUse, recordFlag };
