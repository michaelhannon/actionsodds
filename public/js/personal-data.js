/**
 * Action's Odds — Personal Data Module
 *
 * Centralizes all server API calls for the dashboard. Replaces the legacy
 * localStorage-based logPlays / paperPlays / cfg.bankroll model.
 *
 * Public API (attached to window.ao):
 *   ao.init()                         — bootstrap: fetch user, plays, bankroll, action's plays
 *   ao.getMe()                        — { id, email, display_name, is_admin, ... }
 *   ao.myPlays()                      — array of user's plays
 *   ao.myBankroll()                   — { starting, current }
 *   ao.actionsPlays()                 — array of Action's Plays (read-only feed)
 *   ao.actionsBankroll()              — array per-sport
 *   ao.addPlay(payload)               — POST /api/me/plays
 *   ao.updatePlay(id, payload)        — PATCH /api/me/plays/:id
 *   ao.deletePlay(id)                 — DELETE /api/me/plays/:id
 *   ao.gradePlay(id, status)          — sugar: ao.updatePlay(id, { status })
 *   ao.setBankroll({starting,current})— PATCH /api/me/bankroll
 *   ao.addActionsPlay(payload)        — admin only
 *   ao.updateActionsPlay(id, payload) — admin only
 *   ao.deleteActionsPlay(id)          — admin only
 *   ao.refresh()                      — reload all data
 */

(function () {
  'use strict';

  const SUPABASE_URL = 'https://xlfsaxfpdpxsdkovvhxs.supabase.co';
  const SUPABASE_ANON = 'sb_publishable_3L81CVKvE9w2agrz6yMe5g_BC4O0pws';

  let supabase = null;
  let session = null;
  let _me = null;
  let _myPlays = [];
  let _myBankroll = { starting: 0, current: 0 };
  let _actionsPlays = [];
  let _actionsBankroll = [];

  // ─── helpers ──────────────────────────────────────────────────────────────
  async function authedFetch(url, opts = {}) {
    const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    if (session?.access_token) headers['Authorization'] = 'Bearer ' + session.access_token;
    const res = await fetch(url, Object.assign({}, opts, { headers }));
    if (!res.ok) {
      const t = await res.text();
      let parsed = null;
      try { parsed = JSON.parse(t); } catch (e) {}
      const msg = parsed?.error || t || `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return res.json();
  }

  // ─── load supabase + session ──────────────────────────────────────────────
  async function loadSupabase() {
    if (supabase) return supabase;
    const m = await import('https://esm.sh/@supabase/supabase-js@2');
    supabase = m.createClient(SUPABASE_URL, SUPABASE_ANON);
    return supabase;
  }

  // ─── init ──────────────────────────────────────────────────────────────────
  async function init() {
    await loadSupabase();
    const { data } = await supabase.auth.getSession();
    session = data?.session || null;
    if (!session) throw new Error('Not authenticated');

    // Fetch all data in parallel
    const [meRes, playsRes, bankrollRes, actionsRes, actionsBankRes] = await Promise.all([
      authedFetch('/api/me').catch(e => { throw new Error('Failed to load profile: ' + e.message); }),
      authedFetch('/api/me/plays').catch(e => ({ plays: [] })),
      authedFetch('/api/me/bankroll').catch(e => ({ starting: 0, current: 0 })),
      authedFetch('/api/actions-plays').catch(e => ({ plays: [] })),
      authedFetch('/api/actions-bankroll').catch(e => ({ bankrolls: [] })),
    ]);

    _me = meRes;
    _myPlays = playsRes.plays || [];
    _myBankroll = { starting: bankrollRes.starting || 0, current: bankrollRes.current || 0 };
    _actionsPlays = actionsRes.plays || [];
    _actionsBankroll = actionsRes.bankrolls || actionsBankRes.bankrolls || [];

    // One-time legacy localStorage migration (idempotent on server)
    await migrateLegacyData();

    return _me;
  }

  // ─── one-time legacy migration ────────────────────────────────────────────
  async function migrateLegacyData() {
    if (_myPlays.length > 0) return; // user already has plays in DB; skip
    let legacy = null;
    try {
      const raw = localStorage.getItem('ao_log');
      if (raw) legacy = JSON.parse(raw);
    } catch (e) {}
    if (!Array.isArray(legacy) || legacy.length === 0) return;

    try {
      const result = await authedFetch('/api/me/plays/bulk-import', {
        method: 'POST',
        body: JSON.stringify({ items: legacy }),
      });
      if (result.imported > 0) {
        // Re-fetch plays to load the imports
        const playsRes = await authedFetch('/api/me/plays').catch(() => ({ plays: [] }));
        _myPlays = playsRes.plays || [];
        // Clear localStorage now that data is safely in DB
        try { localStorage.removeItem('ao_log'); } catch (e) {}
        try { localStorage.removeItem('ao_paper'); } catch (e) {}
        console.log(`[ao] Migrated ${result.imported} plays from localStorage to DB`);
      }
    } catch (err) {
      console.warn('[ao] legacy migration failed:', err.message);
    }
  }

  // ─── personal plays ────────────────────────────────────────────────────────
  async function refreshMyPlays() {
    const r = await authedFetch('/api/me/plays');
    _myPlays = r.plays || [];
    return _myPlays;
  }

  async function addPlay(payload) {
    const r = await authedFetch('/api/me/plays', { method: 'POST', body: JSON.stringify(payload) });
    if (r.play) _myPlays.unshift(r.play);
    return r.play;
  }

  async function updatePlay(id, payload) {
    const r = await authedFetch('/api/me/plays/' + encodeURIComponent(id), {
      method: 'PATCH', body: JSON.stringify(payload),
    });
    if (r.play) {
      const idx = _myPlays.findIndex(p => p.id === id);
      if (idx >= 0) _myPlays[idx] = r.play;
    }
    return r.play;
  }

  async function deletePlay(id) {
    await authedFetch('/api/me/plays/' + encodeURIComponent(id), { method: 'DELETE' });
    _myPlays = _myPlays.filter(p => p.id !== id);
  }

  function gradePlay(id, status) {
    return updatePlay(id, { status });
  }

  // ─── bankroll ──────────────────────────────────────────────────────────────
  async function setBankroll(updates) {
    const r = await authedFetch('/api/me/bankroll', { method: 'PATCH', body: JSON.stringify(updates) });
    _myBankroll = { starting: r.starting || 0, current: r.current || 0 };
    return _myBankroll;
  }

  // ─── action's plays (admin write) ─────────────────────────────────────────
  async function addActionsPlay(payload) {
    const r = await authedFetch('/api/admin/actions-plays', { method: 'POST', body: JSON.stringify(payload) });
    if (r.play) _actionsPlays.unshift(r.play);
    return r.play;
  }
  async function updateActionsPlay(id, payload) {
    const r = await authedFetch('/api/admin/actions-plays/' + encodeURIComponent(id), {
      method: 'PATCH', body: JSON.stringify(payload),
    });
    if (r.play) {
      const idx = _actionsPlays.findIndex(p => p.id === id);
      if (idx >= 0) _actionsPlays[idx] = r.play;
    }
    return r.play;
  }
  async function deleteActionsPlay(id) {
    await authedFetch('/api/admin/actions-plays/' + encodeURIComponent(id), { method: 'DELETE' });
    _actionsPlays = _actionsPlays.filter(p => p.id !== id);
  }

  async function refresh() {
    const [playsRes, bankrollRes, actionsRes, actionsBankRes] = await Promise.all([
      authedFetch('/api/me/plays').catch(() => ({ plays: _myPlays })),
      authedFetch('/api/me/bankroll').catch(() => _myBankroll),
      authedFetch('/api/actions-plays').catch(() => ({ plays: _actionsPlays })),
      authedFetch('/api/actions-bankroll').catch(() => ({ bankrolls: _actionsBankroll })),
    ]);
    _myPlays = playsRes.plays || _myPlays;
    _myBankroll = { starting: bankrollRes.starting || 0, current: bankrollRes.current || 0 };
    _actionsPlays = actionsRes.plays || _actionsPlays;
    _actionsBankroll = actionsRes.bankrolls || _actionsBankroll;
  }

  // ─── computed summaries ───────────────────────────────────────────────────
  function summarize(plays) {
    const settled = plays.filter(p => p.status === 'win' || p.status === 'loss');
    const wins = settled.filter(p => p.status === 'win').length;
    const losses = settled.filter(p => p.status === 'loss').length;
    const pending = plays.filter(p => p.status === 'pending').length;
    const winPct = settled.length ? Math.round(wins / settled.length * 100) : 0;
    const pnl = plays.reduce((acc, p) => acc + (Number(p.pnl) || 0), 0);
    return {
      total: plays.length, settled: settled.length, wins, losses, pending, winPct,
      pnl: Number(pnl.toFixed(2)),
    };
  }

  function summaryByCategory(plays) {
    const core = plays.filter(p => p.bet_category === 'core');
    const exotic = plays.filter(p => p.bet_category === 'exotic');
    return { core: summarize(core), exotic: summarize(exotic), combined: summarize(plays) };
  }

  // ─── public api ────────────────────────────────────────────────────────────
  window.ao = {
    init,
    refresh,
    getMe: () => _me,
    isAdmin: () => !!_me?.is_admin,
    myPlays: () => _myPlays,
    myBankroll: () => _myBankroll,
    actionsPlays: () => _actionsPlays,
    actionsBankroll: () => _actionsBankroll,
    addPlay, updatePlay, deletePlay, gradePlay,
    setBankroll,
    addActionsPlay, updateActionsPlay, deleteActionsPlay,
    refreshMyPlays,
    summarize, summaryByCategory,
  };
})();
