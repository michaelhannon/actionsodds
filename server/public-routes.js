/**
 * Action's Odds — Public read-only endpoints
 *
 * Mounted in server.js BEFORE the api-routes.js router so these resolve
 * without hitting requireAuth. Used by landing.html (logged-out marketing).
 *
 * Endpoints:
 *   GET /api/public/recent-plays
 *     Returns the most recent GRADED plays (win/loss only, no pending).
 *     Capped at 10. Brief is included so the front-end can fog/show it.
 *     This intentionally HIDES today's pending plays so logged-out
 *     visitors can't free-ride on tonight's edge.
 *
 *   GET /api/public/track-record
 *     Returns Kenny's MLB bankroll summary: starting / current / record /
 *     pnl / units / win-rate / ROI. No user-identifying data.
 *
 * Design intent:
 *   - Public visitors see proof (graded results, live record) — not picks.
 *   - Today's qualifying plays remain locked behind /api/actions-plays
 *     which is auth-gated.
 *
 * Wire-up:
 *   In server.js, BEFORE app.use('/', apiRoutes):
 *     app.use('/', require('./server/public-routes'));
 */

const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('./auth');

// Defensive caching headers — these endpoints are read-heavy and the data
// changes only when the grader cron fires. 60-second public cache is fine.
function setPublicCache(res, seconds = 60) {
  res.setHeader('Cache-Control', `public, max-age=${seconds}`);
}

// ─── Recent graded plays ─────────────────────────────────────────
router.get('/api/public/recent-plays', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('actions_plays')
      .select('id, sport_id, play_date, game, bet_type, selection, odds, stake, status, pnl, brief, bet_category')
      .eq('sport_id', 'mlb')
      .in('status', ['win', 'loss', 'push'])
      .neq('bet_type', 'BACKFILL')
      .order('play_date', { ascending: false })
      .order('id', { ascending: false })
      .limit(10);

    if (error) {
      console.error('[Public] recent-plays error:', error.message);
      return res.status(500).json({ error: 'Could not load recent plays' });
    }
    setPublicCache(res, 60);
    res.json({ plays: data || [] });
  } catch (err) {
    console.error('[Public] recent-plays exception:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ─── Track record summary ────────────────────────────────────────
router.get('/api/public/track-record', async (req, res) => {
  try {
    const { data: br, error: brErr } = await supabaseAdmin
      .from('actions_bankroll')
      .select('sport_id, starting_bankroll, current_bankroll, total_wins, total_losses, total_pushes, updated_at')
      .eq('sport_id', 'mlb')
      .maybeSingle();

    if (brErr) {
      console.error('[Public] track-record error:', brErr.message);
      return res.status(500).json({ error: 'Could not load track record' });
    }
    if (!br) {
      setPublicCache(res, 30);
      return res.json({
        sport_id: 'mlb',
        starting_bankroll: 10000,
        current_bankroll: 10000,
        total_wins: 0, total_losses: 0, total_pushes: 0,
        pnl: 0, units: 0, win_rate: null, roi: null, updated_at: null,
      });
    }

    const starting = Number(br.starting_bankroll) || 10000;
    const current = Number(br.current_bankroll) || starting;
    const pnl = Number((current - starting).toFixed(2));
    const unitSize = starting * 0.01;
    const units = unitSize > 0 ? Number((pnl / unitSize).toFixed(1)) : null;
    const wins = br.total_wins || 0;
    const losses = br.total_losses || 0;
    const pushes = br.total_pushes || 0;
    const wlTotal = wins + losses;
    const win_rate = wlTotal > 0 ? Number(((wins / wlTotal) * 100).toFixed(1)) : null;

    setPublicCache(res, 60);
    res.json({
      sport_id: 'mlb',
      starting_bankroll: starting,
      current_bankroll: current,
      total_wins: wins,
      total_losses: losses,
      total_pushes: pushes,
      pnl,
      units,
      win_rate,
      updated_at: br.updated_at,
    });
  } catch (err) {
    console.error('[Public] track-record exception:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

module.exports = router;
