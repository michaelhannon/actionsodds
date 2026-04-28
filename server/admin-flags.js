/**
 * Action's Odds — Admin Sharing Flags (Phase 2c)
 *
 * Admin-only endpoints for reviewing sharing_flags. Mounts at /api/admin/flags.
 *
 *   GET  /api/admin/flags                       — list unreviewed
 *   POST /api/admin/flags/:id/review            — mark as reviewed
 *                                                 body: { resolution: 'cleared'|'confirmed_sharing'|'false_positive', note? }
 *   POST /api/admin/flags/lock-user             — manually lock a user
 *                                                 body: { userId, reason }
 *
 * Mount in server.js with: app.use(require('./server/admin-flags'));
 */

const express = require('express');
const router = express.Router();

const { supabaseAdmin, requireAuth } = require('./auth');
const sessions = require('./sessions');

function requireAdmin(req, res, next) {
  if (!req.user?.is_admin) return res.status(403).json({ error: 'Admin only' });
  next();
}

// ─── GET /api/admin/flags ────────────────────────────────────────────────
router.get('/api/admin/flags', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { data } = await supabaseAdmin
      .from('unreviewed_sharing_flags')
      .select('*')
      .limit(200);
    res.json({ flags: data || [] });
  } catch (err) {
    console.error('[admin-flags/list] error:', err);
    res.status(500).json({ error: 'Could not list flags' });
  }
});

// ─── POST /api/admin/flags/:id/review ────────────────────────────────────
router.post('/api/admin/flags/:id/review', requireAuth, requireAdmin, async (req, res) => {
  const { resolution, note } = req.body || {};
  const allowed = ['cleared', 'confirmed_sharing', 'false_positive'];
  if (!allowed.includes(resolution)) {
    return res.status(400).json({ error: `resolution must be one of ${allowed.join(', ')}` });
  }

  try {
    const resolutionText = note ? `${resolution}: ${note}` : resolution;
    await supabaseAdmin
      .from('sharing_flags')
      .update({
        reviewed: true,
        reviewed_by: req.user.id,
        reviewed_at: new Date().toISOString(),
        resolution: resolutionText,
      })
      .eq('id', req.params.id);

    res.json({ ok: true });
  } catch (err) {
    console.error('[admin-flags/review] error:', err);
    res.status(500).json({ error: 'Review failed' });
  }
});

// ─── POST /api/admin/flags/lock-user ─────────────────────────────────────
// For when you've reviewed a flag and decided "yes, this user is sharing".
// Locks the account + revokes all sessions in one call.
router.post('/api/admin/flags/lock-user', requireAuth, requireAdmin, async (req, res) => {
  const { userId, reason } = req.body || {};
  if (!userId || !reason) {
    return res.status(400).json({ error: 'userId and reason are required' });
  }

  try {
    await supabaseAdmin
      .from('profiles')
      .update({
        account_locked: true,
        account_locked_reason: reason,
      })
      .eq('user_id', userId);

    await sessions.revokeAllUserSessions(userId, 'admin_locked');

    await supabaseAdmin.from('login_events').insert({
      user_id: userId,
      event_type: 'account_locked',
      metadata: { reason, locked_by: req.user.id },
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('[admin-flags/lock-user] error:', err);
    res.status(500).json({ error: 'Lock failed' });
  }
});

// ─── POST /api/admin/flags/unlock-user ───────────────────────────────────
router.post('/api/admin/flags/unlock-user', requireAuth, requireAdmin, async (req, res) => {
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'userId required' });

  try {
    await supabaseAdmin
      .from('profiles')
      .update({
        account_locked: false,
        account_locked_reason: null,
      })
      .eq('user_id', userId);

    await supabaseAdmin.from('login_events').insert({
      user_id: userId,
      event_type: 'account_unlocked',
      metadata: { unlocked_by: req.user.id },
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('[admin-flags/unlock-user] error:', err);
    res.status(500).json({ error: 'Unlock failed' });
  }
});

module.exports = router;
