/**
 * Action's Odds — Session Management (Phase 2a)
 *
 * Session lifecycle:
 *   - createSession() runs on every successful login. It:
 *     • Runs the velocity check (auto-locks account on impossible travel)
 *     • Detects whether this is a new device (for the email alert in 2b)
 *     • Enforces the concurrent-device limit (default 3)
 *     • Inserts a user_sessions row + a login_events row
 *     • Returns a refresh token + flags for the caller
 *
 *   - validateRefreshToken() — used by the refresh endpoint
 *   - revokeSession()  — single session
 *   - revokeAllUserSessions() — used by Stripe webhook on cancel
 *   - listActiveSessions() — for the /account.html sessions list
 *
 * NOTE: this module is built but NOT yet wired into the login flow. That
 * happens in Phase 2b. Until then, none of these functions get called
 * during a real login — they exist in the codebase, ready to use.
 */

const crypto = require('crypto');
const { supabaseAdmin } = require('./auth');
const { lookup: geoLookup } = require('./geoip');
const { checkVelocity, recordFlag } = require('./sharing-detection');

const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_SESSIONS || '3', 10);
const SESSION_DAYS = parseInt(process.env.SESSION_DURATION_DAYS || '30', 10);

// ─── Helpers ──────────────────────────────────────────────────────────────
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function generateToken(bytes = 48) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function hashFingerprint(input) {
  // Salt with the service-role key so attackers can't precompute fingerprints.
  // Service-role key is server-only; safe to use as a hash salt.
  const salt = process.env.SUPABASE_SERVICE_KEY || 'fallback-salt';
  return crypto
    .createHmac('sha256', salt)
    .update(String(input))
    .digest('hex')
    .substring(0, 32);
}

function buildDeviceId({ clientFingerprint, userAgent }) {
  const seed = clientFingerprint || userAgent || 'unknown';
  return hashFingerprint(seed);
}

function parseUserAgent(ua = '') {
  let browser = 'Unknown browser';
  let os = 'Unknown OS';

  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/Chrome\//.test(ua) && !/Chromium/.test(ua)) browser = 'Chrome';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Safari\//.test(ua) && !/Chrome/.test(ua)) browser = 'Safari';
  else if (/OPR\//.test(ua)) browser = 'Opera';

  if (/Windows NT/.test(ua)) os = 'Windows';
  else if (/Mac OS X/.test(ua)) os = 'macOS';
  else if (/iPhone|iPad/.test(ua)) os = 'iOS';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/Linux/.test(ua)) os = 'Linux';

  return `${browser} on ${os}`;
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Create a session after a successful login. Enforces concurrent device limit
 * and runs the velocity check.
 *
 * Returns one of:
 *   { geoLock: true, evidence }                — caller must NOT issue tokens;
 *                                                account has been locked.
 *   { sessionId, refreshToken, isNewDevice }   — success path
 */
async function createSession({
  userId,
  userEmail,
  clientFingerprint,
  userAgent,
  ip,
}) {
  const geo = geoLookup(ip);
  const deviceId = buildDeviceId({ clientFingerprint, userAgent });
  const deviceName = parseUserAgent(userAgent);

  // ─── 1. Velocity check (auto-lock on impossible travel) ─────────────────
  const velocity = await checkVelocity({
    userId,
    newIp: ip,
    newLat: geo.lat,
    newLon: geo.lon,
    newCity: geo.city,
    newCountry: geo.country,
  });

  if (velocity.isImpossible) {
    await revokeAllUserSessions(userId, 'suspicious_velocity');
    await supabaseAdmin
      .from('profiles')
      .update({
        account_locked: true,
        account_locked_reason: 'Suspicious activity: impossible travel detected',
      })
      .eq('user_id', userId);

    await supabaseAdmin.from('login_events').insert({
      user_id: userId,
      email_attempted: userEmail,
      event_type: 'suspicious_velocity',
      device_id: deviceId,
      user_agent: userAgent,
      ip_address: ip,
      ip_country: geo.country,
      ip_region: geo.region,
      ip_city: geo.city,
      ip_asn: geo.asn,
      metadata: velocity.evidence,
    });

    await recordFlag(userId, {
      flag_type: 'impossible_velocity',
      severity: 'high',
      evidence: velocity.evidence,
    });

    return { geoLock: true, evidence: velocity.evidence };
  }

  // ─── 2. Detect new device ────────────────────────────────────────────────
  const { data: existingTrusted } = await supabaseAdmin
    .from('trusted_devices')
    .select('id')
    .eq('user_id', userId)
    .eq('device_id', deviceId)
    .maybeSingle();

  const isNewDevice = !existingTrusted;

  // ─── 3. Enforce concurrent session limit ────────────────────────────────
  const { data: activeSessions } = await supabaseAdmin
    .from('user_sessions')
    .select('id, device_id, last_seen_at')
    .eq('user_id', userId)
    .is('revoked_at', null)
    .order('last_seen_at', { ascending: true });

  if (activeSessions && activeSessions.length >= MAX_CONCURRENT) {
    const sameDevice = activeSessions.find((s) => s.device_id === deviceId);
    if (!sameDevice) {
      // Bump the oldest session(s) to make room
      const toRevoke = activeSessions.length - MAX_CONCURRENT + 1;
      const oldestIds = activeSessions.slice(0, toRevoke).map((s) => s.id);
      await supabaseAdmin
        .from('user_sessions')
        .update({
          revoked_at: new Date().toISOString(),
          revoked_reason: 'concurrent_limit_exceeded',
        })
        .in('id', oldestIds);
    } else {
      // Same device reconnecting — revoke its old row, we'll insert a fresh one
      await supabaseAdmin
        .from('user_sessions')
        .update({
          revoked_at: new Date().toISOString(),
          revoked_reason: 'replaced_by_new_session',
        })
        .eq('id', sameDevice.id);
    }
  }

  // ─── 4. Create the session row ──────────────────────────────────────────
  const refreshToken = generateToken(48);
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);

  const { data: session, error } = await supabaseAdmin
    .from('user_sessions')
    .insert({
      user_id: userId,
      device_id: deviceId,
      device_name: deviceName,
      user_agent: userAgent,
      ip_address: ip,
      ip_country: geo.country,
      ip_region: geo.region,
      ip_city: geo.city,
      ip_asn: geo.asn,
      refresh_token_hash: hashToken(refreshToken),
      is_trusted: !isNewDevice,
      expires_at: expiresAt.toISOString(),
    })
    .select('id')
    .single();

  if (error) throw error;

  // ─── 5. Log the success ─────────────────────────────────────────────────
  await supabaseAdmin.from('login_events').insert({
    user_id: userId,
    email_attempted: userEmail,
    event_type: 'login_success',
    device_id: deviceId,
    user_agent: userAgent,
    ip_address: ip,
    ip_country: geo.country,
    ip_region: geo.region,
    ip_city: geo.city,
    ip_asn: geo.asn,
    metadata: { lat: geo.lat, lon: geo.lon, isNewDevice },
  });

  // Phase 2b will hook in here to send the new-device email.

  return {
    sessionId: session.id,
    refreshToken,
    isNewDevice,
    geoLock: false,
  };
}

/**
 * Validate a refresh token. Returns the session row (with joined profile)
 * if valid, or null if the token is bad/expired/revoked, or the account
 * is locked.
 */
async function validateRefreshToken(refreshToken) {
  if (!refreshToken) return null;
  const tokenHash = hashToken(refreshToken);

  const { data: session } = await supabaseAdmin
    .from('user_sessions')
    .select('*, profiles!inner(account_locked)')
    .eq('refresh_token_hash', tokenHash)
    .is('revoked_at', null)
    .maybeSingle();

  if (!session) return null;
  if (new Date(session.expires_at) < new Date()) return null;
  if (session.profiles?.account_locked) return null;

  await supabaseAdmin
    .from('user_sessions')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('id', session.id);

  return session;
}

/**
 * Revoke a single session (e.g., user clicks "Sign out this device").
 */
async function revokeSession(sessionId, reason = 'user_logout') {
  await supabaseAdmin
    .from('user_sessions')
    .update({
      revoked_at: new Date().toISOString(),
      revoked_reason: reason,
    })
    .eq('id', sessionId);
}

/**
 * Revoke ALL sessions for a user. Called by:
 *   - Stripe webhook on subscription cancel/lapse
 *   - Velocity check on impossible travel
 *   - User clicking "Sign out everywhere"
 */
async function revokeAllUserSessions(userId, reason = 'all_revoked') {
  await supabaseAdmin
    .from('user_sessions')
    .update({
      revoked_at: new Date().toISOString(),
      revoked_reason: reason,
    })
    .eq('user_id', userId)
    .is('revoked_at', null);
}

/**
 * For the /account.html "Active sessions" list.
 */
async function listActiveSessions(userId) {
  const { data } = await supabaseAdmin
    .from('user_sessions')
    .select('id, device_name, ip_city, ip_region, ip_country, last_seen_at, created_at, is_trusted')
    .eq('user_id', userId)
    .is('revoked_at', null)
    .order('last_seen_at', { ascending: false });
  return data || [];
}

module.exports = {
  createSession,
  validateRefreshToken,
  revokeSession,
  revokeAllUserSessions,
  listActiveSessions,
  buildDeviceId,
  parseUserAgent,
  MAX_CONCURRENT,
  SESSION_DAYS,
};
