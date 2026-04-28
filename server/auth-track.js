/**
 * Action's Odds — Auth Tracking Endpoint (Phase 2b)
 *
 * Mounts /api/auth/* routes that wire the Phase 2a foundation
 * (sessions, sharing-detection, email) into the user-facing login flow.
 *
 * Endpoints:
 *
 *   POST /api/auth/track-login       — Called by front-end after Supabase
 *                                       signIn succeeds. Records the session,
 *                                       runs velocity check, sends new-device
 *                                       alert if applicable.
 *                                       Returns: { ok, isNewDevice, geoLock }
 *
 *   GET  /api/auth/sessions          — List active sessions (account UI)
 *   POST /api/auth/sessions/:id/revoke
 *                                    — Revoke one session
 *   POST /api/auth/sessions/revoke-others
 *                                    — Revoke all but the current session
 *
 *   GET  /api/auth/login-history     — Recent login events (account UI)
 *
 *   GET  /api/auth/verify-device     — Email link handler.
 *                                       ?t=<token>  with token created by
 *                                       sendNewDeviceAlert in sessions.js
 *
 * Mount in server.js with: app.use(require('./server/auth-track'));
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const { supabaseAdmin, requireAuth } = require('./auth');
const { getClientIp, lookup: geoLookup } = require('./geoip');
const sessions = require('./sessions');
const email = require('./email');

const APP_URL = process.env.APP_URL || 'https://actionsodds.com';

function generateToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

// ─── POST /api/auth/track-login ──────────────────────────────────────────
// Called by the front-end immediately after supabase.auth.signInWithPassword
// (or signInWithOtp) succeeds. We re-derive the user from their JWT and
// then run all the Phase 2 checks server-side.
router.post('/api/auth/track-login', requireAuth, async (req, res) => {
  try {
    const { fingerprint } = req.body || {};
    const userAgent = req.headers['user-agent'] || '';
    const ip = getClientIp(req);

    const result = await sessions.createSession({
      userId: req.user.id,
      userEmail: req.user.email,
      clientFingerprint: fingerprint,
      userAgent,
      ip,
    });

    // ─── If velocity check failed: account is now locked, sessions revoked ─
    if (result.geoLock) {
      // Send the alert email (don't await, don't fail the response if it fails)
      email
        .sendVelocityAlert({
          to: req.user.email,
          locationA: result.evidence.locationA,
          locationB: result.evidence.locationB,
          minutesBetween: result.evidence.minutesBetween,
        })
        .catch((e) => console.error('[track-login] velocity email failed:', e?.message));

      return res.status(423).json({
        ok: false,
        geoLock: true,
        message: 'Suspicious sign-in activity detected. Account locked. Check your email.',
      });
    }

    // ─── If this is a new device, fire off the "was this you?" email ──────
    if (result.isNewDevice) {
      const confirmToken = generateToken();
      const revokeToken = generateToken();
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

      await supabaseAdmin.from('device_verification_tokens').insert([
        {
          token: confirmToken,
          user_id: req.user.id,
          session_id: result.sessionId,
          action: 'confirm',
          expires_at: expiresAt,
        },
        {
          token: revokeToken,
          user_id: req.user.id,
          session_id: result.sessionId,
          action: 'revoke',
          expires_at: expiresAt,
        },
      ]);

      const geo = geoLookup(ip);
      const location = [geo.city, geo.region, geo.country].filter(Boolean).join(', ') || 'Unknown';
      const deviceName = sessions.parseUserAgent(userAgent);

      email
        .sendNewDeviceAlert({
          to: req.user.email,
          deviceName,
          location,
          ip,
          confirmUrl: `${APP_URL}/api/auth/verify-device?t=${confirmToken}`,
          revokeUrl: `${APP_URL}/api/auth/verify-device?t=${revokeToken}`,
          when: new Date().toUTCString(),
        })
        .catch((e) => console.error('[track-login] new-device email failed:', e?.message));
    }

    res.json({
      ok: true,
      sessionId: result.sessionId,
      isNewDevice: result.isNewDevice,
    });
  } catch (err) {
    console.error('[track-login] error:', err);
    res.status(500).json({ ok: false, error: 'track-login failed' });
  }
});

// ─── GET /api/auth/sessions ──────────────────────────────────────────────
router.get('/api/auth/sessions', requireAuth, async (req, res) => {
  try {
    const list = await sessions.listActiveSessions(req.user.id);
    res.json({ sessions: list, max: sessions.MAX_CONCURRENT });
  } catch (err) {
    console.error('[sessions/list] error:', err);
    res.status(500).json({ error: 'Could not list sessions' });
  }
});

// ─── POST /api/auth/sessions/:id/revoke ──────────────────────────────────
router.post('/api/auth/sessions/:id/revoke', requireAuth, async (req, res) => {
  try {
    // Confirm the session belongs to this user before revoking
    const { data } = await supabaseAdmin
      .from('user_sessions')
      .select('user_id')
      .eq('id', req.params.id)
      .maybeSingle();

    if (!data || data.user_id !== req.user.id) {
      return res.status(404).json({ error: 'Session not found' });
    }
    await sessions.revokeSession(req.params.id, 'user_revoked');
    res.json({ ok: true });
  } catch (err) {
    console.error('[sessions/revoke] error:', err);
    res.status(500).json({ error: 'Revoke failed' });
  }
});

// ─── POST /api/auth/sessions/revoke-others ───────────────────────────────
router.post('/api/auth/sessions/revoke-others', requireAuth, async (req, res) => {
  try {
    // Identify the current device by fingerprint so we don't revoke ourselves
    const userAgent = req.headers['user-agent'] || '';
    const fp = req.body?.fingerprint;
    const currentDeviceId = sessions.buildDeviceId({ clientFingerprint: fp, userAgent });

    const { data: rows } = await supabaseAdmin
      .from('user_sessions')
      .select('id, device_id')
      .eq('user_id', req.user.id)
      .is('revoked_at', null);

    let revoked = 0;
    for (const row of rows || []) {
      if (row.device_id !== currentDeviceId) {
        await sessions.revokeSession(row.id, 'user_revoked_all_others');
        revoked++;
      }
    }
    res.json({ ok: true, revoked });
  } catch (err) {
    console.error('[sessions/revoke-others] error:', err);
    res.status(500).json({ error: 'Revoke-others failed' });
  }
});

// ─── GET /api/auth/login-history ─────────────────────────────────────────
router.get('/api/auth/login-history', requireAuth, async (req, res) => {
  try {
    const { data } = await supabaseAdmin
      .from('login_events')
      .select('event_type, ip_city, ip_region, ip_country, user_agent, created_at')
      .eq('user_id', req.user.id)
      .in('event_type', [
        'login_success',
        'login_failed',
        'new_device',
        'suspicious_velocity',
        'session_revoked',
      ])
      .order('created_at', { ascending: false })
      .limit(50);
    res.json({ events: data || [] });
  } catch (err) {
    console.error('[login-history] error:', err);
    res.status(500).json({ error: 'Could not fetch history' });
  }
});

// ─── GET /api/auth/verify-device — email link handler ────────────────────
// Renders an HTML page (so the link works in any email client). No auth
// required — the token IS the auth (single-use, expires in 7d).
router.get('/api/auth/verify-device', async (req, res) => {
  const token = req.query.t;
  if (!token) return res.status(400).send('Missing token');

  try {
    const { data: row } = await supabaseAdmin
      .from('device_verification_tokens')
      .select('*')
      .eq('token', token)
      .is('used_at', null)
      .maybeSingle();

    if (!row || new Date(row.expires_at) < new Date()) {
      return res.status(400).send(htmlPage('Link expired', 'This sign-in link has expired or already been used.'));
    }

    if (row.action === 'confirm') {
      const { data: session } = await supabaseAdmin
        .from('user_sessions')
        .select('device_id, device_name, user_id')
        .eq('id', row.session_id)
        .maybeSingle();

      if (session) {
        await supabaseAdmin
          .from('trusted_devices')
          .upsert(
            {
              user_id: session.user_id,
              device_id: session.device_id,
              device_name: session.device_name,
            },
            { onConflict: 'user_id,device_id' }
          );

        await supabaseAdmin
          .from('user_sessions')
          .update({ is_trusted: true })
          .eq('id', row.session_id);
      }
    } else if (row.action === 'revoke') {
      await sessions.revokeSession(row.session_id, 'email_revoked');
    }

    await supabaseAdmin
      .from('device_verification_tokens')
      .update({ used_at: new Date().toISOString() })
      .eq('token', token);

    const heading = row.action === 'confirm' ? 'Device Trusted' : 'Device Signed Out';
    const body =
      row.action === 'confirm'
        ? "We've remembered this device. You won't get an alert next time you sign in from it."
        : "That session has been signed out. If you didn't request this, change your password right away.";

    res.send(htmlPage(heading, body));
  } catch (err) {
    console.error('[verify-device] error:', err);
    res.status(500).send(htmlPage('Something went wrong', 'Try again, or contact support.'));
  }
});

// ─── Plain HTML page used by /verify-device responses ────────────────────
function htmlPage(heading, body) {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<title>Action's Odds</title>
<style>
  body{margin:0;background:#0a0e1a;color:#e8ebf1;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:grid;place-items:center;min-height:100vh;padding:20px;}
  .card{max-width:440px;background:#121826;border:1px solid #2a3447;border-radius:12px;padding:40px;text-align:center;}
  h1{color:#d4af37;font-family:Georgia,serif;margin:0 0 12px;font-size:26px;}
  p{color:#a0a8b8;font-size:15px;line-height:1.6;margin:0 0 16px;}
  a{color:#d4af37;text-decoration:none;}
  a:hover{text-decoration:underline;}
</style></head>
<body><div class="card">
  <h1>${heading}</h1>
  <p>${body}</p>
  <p><a href="${APP_URL}">← Return to Action's Odds</a></p>
</div></body></html>`;
}

module.exports = router;
