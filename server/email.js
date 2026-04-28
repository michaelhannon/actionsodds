/**
 * Action's Odds — Transactional Email (Phase 2b)
 *
 * All emails go through Resend. Templates are HTML-only with table-based
 * layouts (max compatibility with Gmail / iOS Mail / Outlook).
 *
 * If RESEND_API_KEY is missing, all functions log a warning and no-op
 * instead of crashing — so you can still test other parts of Phase 2b
 * locally without email.
 */

const { Resend } = require('resend');

const RESEND_KEY = process.env.RESEND_API_KEY;
const FROM_ADDRESS = process.env.EMAIL_FROM_ADDRESS || 'auth@actionsodds.com';
const FROM_NAME = process.env.EMAIL_FROM_NAME || "Action's Odds";
const FROM = `${FROM_NAME} <${FROM_ADDRESS}>`;
const APP_URL = process.env.APP_URL || 'https://actionsodds.com';

const resend = RESEND_KEY ? new Resend(RESEND_KEY) : null;
if (!resend) {
  console.warn('[email] RESEND_API_KEY missing — emails will be logged but not sent');
}

// ─── Shared HTML shell — Action's Odds branded ────────────────────────────
function shell(title, content) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${title}</title></head>
<body style="margin:0;padding:0;background:#0a0e1a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0e1a;padding:32px 16px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#121826;border:1px solid #2a3447;border-radius:12px;overflow:hidden;">
        <tr><td style="padding:24px 32px;border-bottom:1px solid #2a3447;">
          <div style="font-family:Georgia,serif;font-size:24px;font-weight:700;color:#0a2a5e;letter-spacing:-0.01em;">
            ACTION'S<span style="color:#bf0d3e;">ODDS</span>
          </div>
          <div style="font-size:11px;color:#a0a8b8;letter-spacing:0.18em;text-transform:uppercase;margin-top:4px;">
            MLB · NHL · NBA · NFL · GOLF
          </div>
        </td></tr>
        <tr><td style="padding:32px;color:#e8ebf1;font-size:15px;line-height:1.6;">
          ${content}
        </td></tr>
        <tr><td style="padding:20px 32px;border-top:1px solid #2a3447;color:#6b7488;font-size:12px;">
          You're receiving this because you have an account at Action's Odds.<br>
          Manage notifications: <a href="${APP_URL}/account.html" style="color:#d4af37;">your account</a>.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function btnPrimary(href, label) {
  return `<a href="${href}" style="display:inline-block;background:#d4af37;color:#0a0e1a;padding:11px 22px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px;">${label}</a>`;
}

function btnLink(href, label) {
  return `<a href="${href}" style="color:#d4af37;text-decoration:underline;">${label}</a>`;
}

// ─── send() helper — uniform error handling + safe-no-op when no key ─────
async function send({ to, subject, html }) {
  if (!resend) {
    console.log('[email/no-op]', subject, '→', to);
    return { ok: false, reason: 'no_api_key' };
  }
  try {
    const result = await resend.emails.send({ from: FROM, to, subject, html });
    if (result.error) {
      console.error('[email] send failed:', result.error);
      return { ok: false, reason: 'send_error', detail: result.error };
    }
    return { ok: true, id: result.data?.id };
  } catch (err) {
    console.error('[email] threw:', err.message);
    return { ok: false, reason: 'exception', detail: err.message };
  }
}

// ─── Template: new device sign-in ────────────────────────────────────────
async function sendNewDeviceAlert({ to, deviceName, location, ip, confirmUrl, revokeUrl, when }) {
  const html = shell(
    'New device sign-in',
    `
    <h2 style="margin:0 0 16px;color:#fff;font-size:20px;font-weight:600;">New device signed in</h2>
    <p>Someone just signed in to your Action's Odds account from a new device:</p>
    <table cellpadding="6" style="background:#0a0e1a;border-radius:6px;margin:18px 0;width:100%;border-collapse:separate;border-spacing:0;">
      <tr><td style="color:#a0a8b8;width:90px;font-size:13px;">Device</td><td style="color:#e8ebf1;font-size:14px;">${deviceName || 'Unknown'}</td></tr>
      <tr><td style="color:#a0a8b8;font-size:13px;">Location</td><td style="color:#e8ebf1;font-size:14px;">${location || 'Unknown'}</td></tr>
      <tr><td style="color:#a0a8b8;font-size:13px;">IP</td><td style="color:#e8ebf1;font-family:monospace;font-size:13px;">${ip || 'Unknown'}</td></tr>
      <tr><td style="color:#a0a8b8;font-size:13px;">When</td><td style="color:#e8ebf1;font-size:14px;">${when}</td></tr>
    </table>
    <p style="margin:20px 0 14px;"><strong style="color:#fff;">Was this you?</strong></p>
    <p style="margin:0 0 16px;">${btnPrimary(confirmUrl, 'Yes, that was me')} &nbsp; ${btnLink(revokeUrl, 'No, sign that device out →')}</p>
    <p style="color:#a0a8b8;font-size:13px;margin-top:20px;">If you don't recognize this, sign that device out using the link above and change your password right away.</p>
    `
  );

  return send({ to, subject: `New device signed in to Action's Odds`, html });
}

// ─── Template: suspicious velocity (account auto-locked) ─────────────────
async function sendVelocityAlert({ to, locationA, locationB, minutesBetween }) {
  const html = shell(
    'Suspicious sign-in activity',
    `
    <h2 style="margin:0 0 16px;color:#fff;font-size:20px;font-weight:600;">Suspicious activity on your account</h2>
    <p>We detected sign-ins from two distant locations within ${minutesBetween} minutes of each other:</p>
    <ul style="color:#e8ebf1;line-height:1.8;">
      <li><strong>${locationA}</strong></li>
      <li><strong>${locationB}</strong></li>
    </ul>
    <p>That's physically impossible for one person, so for your protection we've signed you out of all devices.</p>
    <p style="margin:20px 0;">${btnPrimary(`${APP_URL}/auth/login.html`, 'Sign in again')}</p>
    <p style="color:#a0a8b8;font-size:13px;">If you were using a VPN, just sign in again. If not, change your password the moment you sign in.</p>
    `
  );

  return send({ to, subject: `Suspicious activity on your Action's Odds account`, html });
}

// ─── Template: subscription canceled — sessions revoked ──────────────────
async function sendSubscriptionEndedAlert({ to, sport }) {
  const html = shell(
    'Your subscription ended',
    `
    <h2 style="margin:0 0 16px;color:#fff;font-size:20px;font-weight:600;">Your ${(sport || '').toUpperCase()} subscription has ended</h2>
    <p>You've been signed out of Action's Odds. To keep your access, you can resubscribe anytime:</p>
    <p style="margin:20px 0;">${btnPrimary(`${APP_URL}/pricing.html`, 'Resubscribe')}</p>
    <p style="color:#a0a8b8;font-size:13px;">If this was an error or you have questions, reply to this email.</p>
    `
  );

  return send({ to, subject: `Your Action's Odds subscription has ended`, html });
}

module.exports = {
  sendNewDeviceAlert,
  sendVelocityAlert,
  sendSubscriptionEndedAlert,
};
