/**
 * Action's Odds — Phase 3 API routes
 *
 * Mounts a single Express Router with all the personal-data and admin endpoints.
 *
 * Mount in server.js after express.json() and after auth helpers are imported:
 *   const apiRoutes = require('./server/api-routes');
 *   app.use(apiRoutes);
 *
 * Endpoints:
 *
 *   PERSONAL PLAYS (logged-in user)
 *   ─────────────────────────────────────────────────────────
 *   GET    /api/me/plays                  list current user's plays
 *   POST   /api/me/plays                  create a personal play
 *   PATCH  /api/me/plays/:id              update a personal play (status/grade or fields)
 *   DELETE /api/me/plays/:id              delete a personal play
 *   POST   /api/me/plays/bulk-import      one-time localStorage migration import
 *
 *   PERSONAL BANKROLL (logged-in user)
 *   ─────────────────────────────────────────────────────────
 *   GET    /api/me/bankroll               { starting, current }
 *   PATCH  /api/me/bankroll               update starting / current
 *
 *   ACTION'S PLAYS (read by all auth users; write admin only)
 *   ─────────────────────────────────────────────────────────
 *   GET    /api/actions-plays             list (any auth user)
 *   GET    /api/actions-bankroll          list per-sport bankrolls
 *   POST   /api/admin/actions-plays           ADMIN create
 *   PATCH  /api/admin/actions-plays/:id       ADMIN update
 *   DELETE /api/admin/actions-plays/:id       ADMIN delete
 *   PATCH  /api/admin/actions-bankroll/:sport ADMIN update bankroll for a sport
 *
 *   USER MANAGEMENT (admin only)
 *   ─────────────────────────────────────────────────────────
 *   GET    /api/admin/users                  list all users with profile + sub
 *   PATCH  /api/admin/users/:id              update is_admin / display_name
 *   POST   /api/admin/users/:id/reset-password  send reset email
 *   DELETE /api/admin/users/:id              delete user (cascade)
 *   POST   /api/admin/users                  create user manually + send invite
 *   POST   /api/admin/users/:id/comp          comp a sport (admin grants free sub)
 */

const express = require('express');
const { requireAuth, requireAdmin, supabaseAdmin } = require('./auth');

const router = express.Router();

/* ============================================================================
 * Helpers
 * ========================================================================== */

// American odds → profit on win (e.g. -150 stake $300 wins $200; +130 stake $100 wins $130)
function profitForWin(odds, stake) {
  const o = parseInt(odds, 10) || 0;
  const s = parseFloat(stake) || 0;
  if (o === 0 || s === 0) return 0;
  return o > 0 ? s * (o / 100) : s * (100 / Math.abs(o));
}

// Compute pnl based on status + odds + stake
function computePnl(status, odds, stake) {
  if (status === 'win') return Number(profitForWin(odds, stake).toFixed(2));
  if (status === 'loss') return -Number((parseFloat(stake) || 0).toFixed(2));
  return 0; // pending, push, void
}

// Sanitize/validate a play payload (used by personal + admin actions_plays)
function validatePlayPayload(body, { allowPartial = false } = {}) {
  const errors = [];
  const out = {};
  const required = ['sport_id', 'play_date', 'game', 'bet_type', 'selection', 'odds', 'stake'];

  for (const k of required) {
    if (body[k] === undefined || body[k] === null || body[k] === '') {
      if (!allowPartial) errors.push(`${k} is required`);
    } else {
      out[k] = body[k];
    }
  }

  if (out.odds !== undefined) {
    const n = parseInt(out.odds, 10);
    if (isNaN(n)) errors.push('odds must be an integer');
    else out.odds = n;
  }
  if (out.stake !== undefined) {
    const n = parseFloat(out.stake);
    if (isNaN(n) || n < 0) errors.push('stake must be a non-negative number');
    else out.stake = Number(n.toFixed(2));
  }
  if (body.status !== undefined) {
    if (!['pending', 'win', 'loss', 'push', 'void'].includes(body.status)) {
      errors.push('status must be one of pending|win|loss|push|void');
    } else {
      out.status = body.status;
    }
  }
  if (body.bet_category !== undefined) {
    if (!['core', 'exotic'].includes(body.bet_category)) {
      errors.push('bet_category must be core or exotic');
    } else {
      out.bet_category = body.bet_category;
    }
  }
  if (body.notes !== undefined) out.notes = String(body.notes).slice(0, 1000);
  if (body.sport_id !== undefined) {
    if (!['mlb', 'nhl', 'nba', 'nfl', 'golf'].includes(body.sport_id)) {
      errors.push('sport_id must be one of mlb|nhl|nba|nfl|golf');
    }
  }

  return { errors, out };
}

/* ============================================================================
 * PERSONAL PLAYS
 * ========================================================================== */

router.get('/api/me/plays', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('plays')
      .select('*')
      .eq('user_id', req.user.id)
      .order('play_date', { ascending: false })
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ plays: data || [] });
  } catch (err) {
    console.error('GET /api/me/plays', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/me/plays', requireAuth, async (req, res) => {
  try {
    const { errors, out } = validatePlayPayload(req.body);
    if (errors.length) return res.status(400).json({ error: errors.join('; ') });

    const status = out.status || 'pending';
    const pnl = computePnl(status, out.odds, out.stake);

    const insertRow = {
      user_id: req.user.id,
      sport_id: out.sport_id,
      play_date: out.play_date,
      game: out.game,
      bet_type: out.bet_type,
      selection: out.selection,
      odds: out.odds,
      stake: out.stake,
      status,
      pnl,
      bet_category: out.bet_category || 'core',
      notes: out.notes || null,
    };

    const { data, error } = await supabaseAdmin
      .from('plays').insert(insertRow).select().single();
    if (error) throw error;
    res.json({ play: data });
  } catch (err) {
    console.error('POST /api/me/plays', err);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/api/me/plays/:id', requireAuth, async (req, res) => {
  try {
    const { errors, out } = validatePlayPayload(req.body, { allowPartial: true });
    if (errors.length) return res.status(400).json({ error: errors.join('; ') });

    // Fetch existing to compute pnl correctly when status changes
    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from('plays').select('*').eq('id', req.params.id).eq('user_id', req.user.id).single();
    if (fetchErr || !existing) return res.status(404).json({ error: 'Play not found' });

    const updates = { ...out, updated_at: new Date().toISOString() };
    const finalStatus = updates.status ?? existing.status;
    const finalOdds = updates.odds ?? existing.odds;
    const finalStake = updates.stake ?? existing.stake;
    updates.pnl = computePnl(finalStatus, finalOdds, finalStake);

    const { data, error } = await supabaseAdmin
      .from('plays').update(updates).eq('id', req.params.id).eq('user_id', req.user.id)
      .select().single();
    if (error) throw error;
    res.json({ play: data });
  } catch (err) {
    console.error('PATCH /api/me/plays/:id', err);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/api/me/plays/:id', requireAuth, async (req, res) => {
  try {
    const { error } = await supabaseAdmin
      .from('plays').delete().eq('id', req.params.id).eq('user_id', req.user.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/me/plays/:id', err);
    res.status(500).json({ error: err.message });
  }
});

// One-time bulk import from localStorage. Idempotent: only imports if user has 0 plays.
router.post('/api/me/plays/bulk-import', requireAuth, async (req, res) => {
  try {
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    if (items.length === 0) return res.json({ imported: 0, skipped: 0, reason: 'empty' });

    // Idempotent guard: skip if user already has any plays
    const { count, error: cntErr } = await supabaseAdmin
      .from('plays').select('id', { count: 'exact', head: true }).eq('user_id', req.user.id);
    if (cntErr) throw cntErr;
    if ((count || 0) > 0) return res.json({ imported: 0, skipped: items.length, reason: 'already-has-plays' });

    const rows = [];
    let skipped = 0;
    for (const item of items) {
      // localStorage shape: {game, bet, odds, amt, trigger, type, note, date, result}
      // map → DB columns
      const odds = parseInt(item.odds, 10);
      const stake = parseFloat(item.amt);
      if (!item.game || isNaN(odds) || isNaN(stake)) { skipped++; continue; }

      const status = item.result === 'W' ? 'win' : item.result === 'L' ? 'loss' : 'pending';
      const pnl = computePnl(status, odds, stake);

      let playDate = new Date().toISOString().slice(0, 10);
      if (item.date) {
        // Try to parse "4/25/2026" or "2026-04-25"
        const d = new Date(item.date);
        if (!isNaN(d.getTime())) playDate = d.toISOString().slice(0, 10);
      }

      rows.push({
        user_id: req.user.id,
        sport_id: item.sport_id || 'mlb',
        play_date: playDate,
        game: String(item.game).slice(0, 200),
        bet_type: String(item.bet || 'ML').slice(0, 50),
        selection: String(item.bet || item.game).slice(0, 200),
        odds,
        stake,
        status,
        pnl,
        bet_category: item.type === 'exotic' ? 'exotic' : 'core',
        notes: item.note ? String(item.note).slice(0, 1000) : (item.trigger ? `Trigger: ${item.trigger}` : null),
      });
    }

    if (rows.length === 0) return res.json({ imported: 0, skipped });

    const { error } = await supabaseAdmin.from('plays').insert(rows);
    if (error) throw error;
    res.json({ imported: rows.length, skipped });
  } catch (err) {
    console.error('POST /api/me/plays/bulk-import', err);
    res.status(500).json({ error: err.message });
  }
});

/* ============================================================================
 * PERSONAL BANKROLL
 *
 * We use the profiles table which has starting_bankroll + current_bankroll.
 * ========================================================================== */

router.get('/api/me/bankroll', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('profiles')
      .select('starting_bankroll, current_bankroll')
      .eq('user_id', req.user.id).single();
    if (error) throw error;
    res.json({
      starting: Number(data?.starting_bankroll) || 0,
      current: Number(data?.current_bankroll) || 0,
    });
  } catch (err) {
    console.error('GET /api/me/bankroll', err);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/api/me/bankroll', requireAuth, async (req, res) => {
  try {
    const updates = {};
    if (req.body.starting !== undefined) {
      const v = parseFloat(req.body.starting);
      if (isNaN(v) || v < 0) return res.status(400).json({ error: 'starting must be a non-negative number' });
      updates.starting_bankroll = v;
    }
    if (req.body.current !== undefined) {
      const v = parseFloat(req.body.current);
      if (isNaN(v)) return res.status(400).json({ error: 'current must be a number' });
      updates.current_bankroll = v;
    }
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'nothing to update' });
    updates.updated_at = new Date().toISOString();

    const { data, error } = await supabaseAdmin
      .from('profiles').update(updates).eq('user_id', req.user.id)
      .select('starting_bankroll, current_bankroll').single();
    if (error) throw error;
    res.json({
      starting: Number(data.starting_bankroll) || 0,
      current: Number(data.current_bankroll) || 0,
    });
  } catch (err) {
    console.error('PATCH /api/me/bankroll', err);
    res.status(500).json({ error: err.message });
  }
});

/* ============================================================================
 * ACTION'S PLAYS — public read, admin write
 * ========================================================================== */

router.get('/api/actions-plays', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('actions_plays').select('*')
      .order('play_date', { ascending: false })
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ plays: data || [] });
  } catch (err) {
    console.error('GET /api/actions-plays', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/actions-bankroll', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('actions_bankroll').select('*').order('sport_id');
    if (error) throw error;
    res.json({ bankrolls: data || [] });
  } catch (err) {
    console.error('GET /api/actions-bankroll', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/admin/actions-plays', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { errors, out } = validatePlayPayload(req.body);
    if (errors.length) return res.status(400).json({ error: errors.join('; ') });
    const status = out.status || 'pending';
    const pnl = computePnl(status, out.odds, out.stake);
    const insertRow = {
      sport_id: out.sport_id,
      play_date: out.play_date,
      game: out.game,
      bet_type: out.bet_type,
      selection: out.selection,
      odds: out.odds,
      stake: out.stake,
      status,
      pnl,
      bet_category: out.bet_category || 'core',
      notes: out.notes || null,
    };
    const { data, error } = await supabaseAdmin
      .from('actions_plays').insert(insertRow).select().single();
    if (error) throw error;
    res.json({ play: data });
  } catch (err) {
    console.error('POST /api/admin/actions-plays', err);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/api/admin/actions-plays/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { errors, out } = validatePlayPayload(req.body, { allowPartial: true });
    if (errors.length) return res.status(400).json({ error: errors.join('; ') });
    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from('actions_plays').select('*').eq('id', req.params.id).single();
    if (fetchErr || !existing) return res.status(404).json({ error: 'Play not found' });

    const updates = { ...out, updated_at: new Date().toISOString() };
    const finalStatus = updates.status ?? existing.status;
    const finalOdds = updates.odds ?? existing.odds;
    const finalStake = updates.stake ?? existing.stake;
    updates.pnl = computePnl(finalStatus, finalOdds, finalStake);

    const { data, error } = await supabaseAdmin
      .from('actions_plays').update(updates).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json({ play: data });
  } catch (err) {
    console.error('PATCH /api/admin/actions-plays/:id', err);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/api/admin/actions-plays/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { error } = await supabaseAdmin
      .from('actions_plays').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/admin/actions-plays/:id', err);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/api/admin/actions-bankroll/:sport', requireAuth, requireAdmin, async (req, res) => {
  try {
    const sport = req.params.sport;
    if (!['mlb','nhl','nba','nfl','golf'].includes(sport)) {
      return res.status(400).json({ error: 'invalid sport' });
    }
    const updates = { updated_at: new Date().toISOString() };
    for (const k of ['starting_bankroll','current_bankroll','total_wins','total_losses','total_pushes']) {
      if (req.body[k] !== undefined) {
        const v = parseFloat(req.body[k]);
        if (isNaN(v)) return res.status(400).json({ error: `${k} must be a number` });
        updates[k] = v;
      }
    }
    const { data, error } = await supabaseAdmin
      .from('actions_bankroll').update(updates).eq('sport_id', sport).select().single();
    if (error) throw error;
    res.json({ bankroll: data });
  } catch (err) {
    console.error('PATCH /api/admin/actions-bankroll/:sport', err);
    res.status(500).json({ error: err.message });
  }
});

/* ============================================================================
 * USER MANAGEMENT (admin only)
 * ========================================================================== */

router.get('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    // List auth users
    const { data: usersResp, error: usersErr } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 200 });
    if (usersErr) throw usersErr;
    const users = usersResp?.users || [];

    // Pull profiles + subscription summary in parallel
    const userIds = users.map(u => u.id);
    if (userIds.length === 0) return res.json({ users: [] });

    const [profileRes, subsRes, playsRes] = await Promise.all([
      supabaseAdmin.from('profiles').select('user_id, display_name, is_admin, starting_bankroll, current_bankroll').in('user_id', userIds),
      supabaseAdmin.from('subscriptions').select('user_id, sport_id, status, cadence, current_period_end, cancel_at_period_end').in('user_id', userIds),
      supabaseAdmin.from('plays').select('user_id, pnl, status').in('user_id', userIds),
    ]);

    const profileById = {};
    for (const p of (profileRes.data || [])) profileById[p.user_id] = p;

    const subsByUser = {};
    for (const s of (subsRes.data || [])) {
      if (!subsByUser[s.user_id]) subsByUser[s.user_id] = [];
      subsByUser[s.user_id].push(s);
    }

    const statsByUser = {};
    for (const p of (playsRes.data || [])) {
      const k = p.user_id;
      if (!statsByUser[k]) statsByUser[k] = { plays: 0, wins: 0, losses: 0, pnl: 0 };
      statsByUser[k].plays += 1;
      if (p.status === 'win') statsByUser[k].wins += 1;
      if (p.status === 'loss') statsByUser[k].losses += 1;
      statsByUser[k].pnl += Number(p.pnl) || 0;
    }

    const result = users.map(u => {
      const profile = profileById[u.id] || {};
      const subs = subsByUser[u.id] || [];
      const activeSubs = subs.filter(s => s.status === 'active');
      const stats = statsByUser[u.id] || { plays: 0, wins: 0, losses: 0, pnl: 0 };
      return {
        id: u.id,
        email: u.email,
        created_at: u.created_at,
        last_sign_in_at: u.last_sign_in_at,
        email_confirmed_at: u.email_confirmed_at,
        display_name: profile.display_name || u.email,
        is_admin: !!profile.is_admin,
        starting_bankroll: Number(profile.starting_bankroll) || 0,
        current_bankroll: Number(profile.current_bankroll) || 0,
        sub_count: subs.length,
        active_sub_count: activeSubs.length,
        active_sports: activeSubs.map(s => s.sport_id).sort(),
        plays: stats.plays,
        wins: stats.wins,
        losses: stats.losses,
        pnl: Number(stats.pnl.toFixed(2)),
      };
    });
    res.json({ users: result });
  } catch (err) {
    console.error('GET /api/admin/users', err);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/api/admin/users/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const updates = {};
    if (req.body.is_admin !== undefined) updates.is_admin = !!req.body.is_admin;
    if (req.body.display_name !== undefined) updates.display_name = String(req.body.display_name).slice(0, 100);
    if (req.body.starting_bankroll !== undefined) {
      const v = parseFloat(req.body.starting_bankroll);
      if (!isNaN(v)) updates.starting_bankroll = v;
    }
    if (req.body.current_bankroll !== undefined) {
      const v = parseFloat(req.body.current_bankroll);
      if (!isNaN(v)) updates.current_bankroll = v;
    }
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'nothing to update' });
    updates.updated_at = new Date().toISOString();

    const { data, error } = await supabaseAdmin
      .from('profiles').update(updates).eq('user_id', req.params.id).select().single();
    if (error) throw error;
    res.json({ profile: data });
  } catch (err) {
    console.error('PATCH /api/admin/users/:id', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/admin/users/:id/reset-password', requireAuth, requireAdmin, async (req, res) => {
  try {
    // Look up email
    const { data: u, error: getErr } = await supabaseAdmin.auth.admin.getUserById(req.params.id);
    if (getErr || !u?.user?.email) return res.status(404).json({ error: 'User not found' });

    const baseUrl = process.env.PUBLIC_URL || 'https://www.actionsodds.com';
    const { error } = await supabaseAdmin.auth.resetPasswordForEmail(u.user.email, {
      redirectTo: `${baseUrl}/auth/reset-password.html`,
    });
    if (error) throw error;
    res.json({ ok: true, email: u.user.email });
  } catch (err) {
    console.error('POST /api/admin/users/:id/reset-password', err);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/api/admin/users/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    if (req.params.id === req.user.id) {
      return res.status(400).json({ error: "You can't delete yourself" });
    }
    const { error } = await supabaseAdmin.auth.admin.deleteUser(req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/admin/users/:id', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const display_name = String(req.body.display_name || '').trim();
    const is_admin = !!req.body.is_admin;
    if (!email) return res.status(400).json({ error: 'email required' });

    // Invite the user — they get an email with a magic link to set their password.
    const baseUrl = process.env.PUBLIC_URL || 'https://www.actionsodds.com';
    const { data, error } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
      redirectTo: `${baseUrl}/auth/reset-password.html`,
      data: display_name ? { display_name } : undefined,
    });
    if (error) throw error;

    const userId = data?.user?.id;
    // The auto-create trigger creates a profile row. Update display_name + is_admin if provided.
    if (userId && (display_name || is_admin)) {
      await supabaseAdmin.from('profiles').update({
        ...(display_name ? { display_name } : {}),
        ...(is_admin ? { is_admin: true } : {}),
      }).eq('user_id', userId);
    }

    res.json({ ok: true, user: data?.user });
  } catch (err) {
    console.error('POST /api/admin/users', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/admin/users/:id/comp', requireAuth, requireAdmin, async (req, res) => {
  try {
    const sport = String(req.body.sport_id || '').toLowerCase();
    if (!['mlb','nhl','nba','nfl','golf'].includes(sport)) {
      return res.status(400).json({ error: 'invalid sport_id' });
    }
    // Upsert a "comp" subscription row so requireSport / sub-check passes.
    const row = {
      user_id: req.params.id,
      sport_id: sport,
      cadence: 'monthly',
      is_bundle: false,
      status: 'active',
      stripe_subscription_id: `comp_${req.params.id}_${sport}_${Date.now()}`,
      stripe_customer_id: null,
      current_period_end: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      cancel_at_period_end: false,
    };
    const { data, error } = await supabaseAdmin
      .from('subscriptions').upsert(row, { onConflict: 'user_id,sport_id' })
      .select().single();
    if (error) throw error;
    res.json({ ok: true, subscription: data });
  } catch (err) {
    console.error('POST /api/admin/users/:id/comp', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
