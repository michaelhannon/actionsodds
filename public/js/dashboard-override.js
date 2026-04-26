/**
 * Action's Odds — Dashboard Override (Phase 3)
 *
 * Loaded AFTER the legacy dashboard scripts. Overrides addLog, renderLog,
 * updateLogResult, updateSummary, and addPaper with versions that use
 * window.ao (the API-backed personal data module).
 *
 * Also injects:
 *   - "My Plays" header (replaces ambiguous existing labels)
 *   - "Action's Plays" section below My Plays (read-only feed for users,
 *      with admin "+ Add" button for the publisher)
 *   - Personal bankroll display (per-user, not Kenny's hardcoded $5,587)
 *
 * Boots on DOMContentLoaded after window.ao.init() resolves.
 */

(function () {
  'use strict';

  // Wait for the legacy dashboard to finish initializing before overriding
  function ready(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn);
    } else {
      fn();
    }
  }

  ready(async function () {
    // Wait for window.ao to be available (loaded as separate script)
    let attempts = 0;
    while (!window.ao && attempts < 50) {
      await new Promise(r => setTimeout(r, 100));
      attempts++;
    }
    if (!window.ao) {
      console.warn('[dashboard-override] window.ao not available');
      return;
    }

    try {
      await window.ao.init();
    } catch (err) {
      console.warn('[dashboard-override] ao.init failed:', err.message);
      return;
    }

    const me = window.ao.getMe();
    if (!me) return;

    // ─── 1. Inject "Action's Plays" section ──────────────────────────────────
    injectActionsPlaysSection();

    // ─── 2. Override legacy globals so existing buttons keep working ─────────
    overrideLegacy();

    // ─── 3. Initial render ──────────────────────────────────────────────────
    renderAll();
    // Trigger legacy updateSummary so big top-row stats (tb-wins, etc) refresh with API data
    if (typeof window.updateSummary_legacy === 'function') window.updateSummary_legacy();
    else if (typeof updateSummary === 'function') {
      try { updateSummary(); } catch(e){}
    }
    // Re-render after a short delay in case other scripts ran later
    setTimeout(() => { try { renderAll(); if (typeof updateSummary === 'function') updateSummary(); } catch(e){} }, 500);

    // Expose for debugging
    window.aoUI = { renderAll, renderMyPlays, renderActionsPlays, renderSummaries };
  });

  // ─── helpers ─────────────────────────────────────────────────────────────
  function fmtMoney(n) {
    const x = Number(n) || 0;
    const sign = x >= 0 ? '+' : '-';
    return sign + '$' + Math.abs(Math.round(x)).toLocaleString();
  }
  function fmtOdds(o) {
    const n = parseInt(o, 10);
    if (isNaN(n) || n === 0) return '';
    return n > 0 ? '+' + n : String(n);
  }
  function fmtDate(d) {
    if (!d) return '';
    const dt = new Date(d);
    if (isNaN(dt.getTime())) return d;
    return (dt.getMonth() + 1) + '/' + dt.getDate();
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }

  // ─── inject Action's Plays section ──────────────────────────────────────
  function injectActionsPlaysSection() {
    if (document.getElementById('actions-plays-section')) return;

    // Find the My Plays / Log section to insert AFTER it
    const logList = document.getElementById('log-list');
    if (!logList) return;
    const logSection = logList.closest('.section, .card, .panel') || logList.parentElement;
    if (!logSection) return;

    const isAdmin = window.ao.isAdmin();

    const wrap = document.createElement('div');
    wrap.id = 'actions-plays-section';
    wrap.style.cssText = 'margin-top:24px;background:var(--panel,#121826);border:1px solid var(--border2,#2a3447);border-radius:8px;padding:16px;';
    wrap.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;margin-bottom:12px;">
        <div>
          <div style="font-family:'Bebas Neue',sans-serif;font-size:18px;letter-spacing:0.04em;color:var(--gold,#d4af37);">Action's Plays</div>
          <div style="font-size:11px;color:var(--text3,#6b7488);letter-spacing:0.06em;text-transform:uppercase;margin-top:2px;">Picks published by Action's Odds · cumulative running results</div>
        </div>
        ${isAdmin ? `<button id="btn-add-actions-play" style="background:var(--gold,#d4af37);border:none;color:#0a0e1a;padding:6px 14px;border-radius:5px;cursor:pointer;font-family:'Barlow Condensed',sans-serif;font-size:12px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;">+ Add Play</button>` : ''}
      </div>
      <div id="actions-plays-stats" style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:14px;font-size:13px;"></div>
      <div id="actions-plays-list"></div>
    `;
    logSection.parentNode.insertBefore(wrap, logSection.nextSibling);

    if (isAdmin) {
      document.getElementById('btn-add-actions-play').addEventListener('click', openAddActionsPlay);
    }
  }

  // ─── override legacy globals ─────────────────────────────────────────────
  function overrideLegacy() {
    // Full replacement of legacy updateSummary that reads from API
    window.updateSummary = function() {
      try {
        const plays = window.ao.myPlays();
        const settled = plays.filter(p => p.status === 'win' || p.status === 'loss');
        const wins = settled.filter(p => p.status === 'win').length;
        const losses = settled.filter(p => p.status === 'loss').length;
        const pending = plays.filter(p => p.status === 'pending').length;
        const winPct = settled.length ? Math.round(wins / settled.length * 100) : 0;
        const corePnl = plays.filter(p => p.bet_category !== 'exotic').reduce((a,p) => a + (Number(p.pnl)||0), 0);
        const exoticPnl = plays.filter(p => p.bet_category === 'exotic').reduce((a,p) => a + (Number(p.pnl)||0), 0);
        const combinedPnl = corePnl + exoticPnl;
        const atRisk = plays.filter(p => p.status === 'pending').reduce((a,p) => a + (Number(p.stake)||0), 0);
        const fmtMoney = n => (n>=0?'+':'-') + '$' + Math.abs(Math.round(n)).toLocaleString();
        const setText = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
        const setHTML = (id, txt, klass) => {
          const el = document.getElementById(id);
          if (!el) return;
          el.textContent = txt;
          if (klass !== undefined) el.className = klass;
        };
        // Top stat cards
        setHTML('s-pnl', fmtMoney(corePnl), 'stat-val ' + (corePnl>=0?'green':'red'));
        setHTML('s-exotic', fmtMoney(exoticPnl), 'stat-val ' + (exoticPnl>=0?'gold':'red'));
        setHTML('s-combined', fmtMoney(combinedPnl), 'stat-val ' + (combinedPnl>=0?'gold':'red'));
        setText('s-record', `${wins}W–${losses}L · ${winPct}%`);
        setText('s-stake', atRisk > 0 ? '$' + atRisk.toLocaleString() + ' at risk' : '$0 at risk');
        // Bankroll
        const bk = window.ao.myBankroll();
        setText('s-bank', '$' + Math.round(bk.current||0).toLocaleString());
        // Top banner big stats
        setText('tb-wins', wins);
        setText('tb-losses', losses);
        setText('tb-pend', pending);
        setText('tb-pct', winPct + '%');
        // Tracker panel (lw-*)
        setText('lw-w', wins);
        setText('lw-l', losses);
        setText('lw-pend', pending);
        setText('lw-roi', winPct + '%');
        const lwPnl = document.getElementById('lw-pnl');
        if (lwPnl) { lwPnl.textContent = fmtMoney(corePnl); lwPnl.style.color = corePnl >= 0 ? '' : 'var(--red)'; }
        const lwEx = document.getElementById('lw-exotic');
        if (lwEx) { lwEx.textContent = fmtMoney(exoticPnl); lwEx.style.color = exoticPnl >= 0 ? '' : 'var(--red)'; }
      } catch (err) { console.warn('[ao] updateSummary failed:', err.message); }
    };

    // The legacy code reads logPlays array directly. Keep it in sync as a mirror.
    Object.defineProperty(window, 'logPlays', {
      configurable: true,
      get: function () {
        return window.ao.myPlays().map(legacyShape);
      },
      set: function () { /* readonly via API now */ }
    });

    // Replace addLog
    window.addLog = async function () {
      const game = (document.getElementById('l-game')?.value || '').trim();
      const bet = (document.getElementById('l-bet')?.value || '').trim();
      const odds = (document.getElementById('l-odds')?.value || '').trim();
      const amt = (document.getElementById('l-amt')?.value || '').trim();
      const trigger = (document.getElementById('l-trigger')?.value || '').trim();
      const note = (document.getElementById('l-note')?.value || '').trim();
      const typeSelect = document.getElementById('l-type');
      const type = typeSelect ? typeSelect.value : 'core';

      if (!game || !odds || !amt) { alert('Game, odds and stake are required'); return; }
      try {
        await window.ao.addPlay({
          sport_id: 'mlb',
          play_date: new Date().toISOString().slice(0, 10),
          game,
          bet_type: 'ML',
          selection: bet || game,
          odds: parseInt(odds, 10),
          stake: parseFloat(amt),
          status: 'pending',
          bet_category: type === 'exotic' ? 'exotic' : 'core',
          notes: note || (trigger ? `Trigger: ${trigger}` : null),
        });
        ['l-game','l-bet','l-odds','l-amt','l-trigger','l-note'].forEach(id => {
          const el = document.getElementById(id); if (el) el.value = '';
        });
        renderAll();
      } catch (err) { alert('Failed to add play: ' + err.message); }
    };

    // Replace updateLogResult — legacy passes index, we map to id
    window.updateLogResult = async function (idx, result) {
      const plays = window.ao.myPlays();
      const play = plays[idx];
      if (!play) return;
      const status = result === 'W' ? 'win' : result === 'L' ? 'loss' : 'pending';
      try {
        await window.ao.gradePlay(play.id, status);
        renderAll();
      } catch (err) { alert('Failed to grade play: ' + err.message); }
    };

    // Override renderLog — legacy expects to render to #log-list
    window.renderLog = function (filter = 'all') {
      renderMyPlays(filter);
    };

    // Override updateSummary — handled above with full implementation
    // (this stub block intentionally removed)

    // Disable paperPlays-related globals that no longer apply
    window.paperPlays = [];
    window.savePaper = function () {};
    window.addPaper = function () { alert('Paper trades have been replaced by My Plays.'); };
    window.updatePaperResult = function () {};
    window.renderPaper = function () {
      const el = document.getElementById('paper-list');
      if (el) el.innerHTML = '<div class="empty" style="padding:16px;color:var(--text3);font-size:13px;">Paper trades replaced by My Plays section above.</div>';
    };
  }

  // Map a DB play row to the legacy shape so existing renderers work
  function legacyShape(p) {
    const result = p.status === 'win' ? 'W' : p.status === 'loss' ? 'L' : null;
    return {
      _id: p.id,
      game: p.game,
      bet: p.selection,
      odds: String(p.odds),
      amt: String(p.stake),
      trigger: p.notes && p.notes.startsWith('Trigger:') ? p.notes.replace(/^Trigger:\s*/, '') : '',
      note: p.notes,
      date: p.play_date,
      result,
      type: p.bet_category === 'exotic' ? 'exotic' : 'core',
    };
  }

  // ─── render: My Plays section ────────────────────────────────────────────
  function renderMyPlays(filter = 'all') {
    let plays = window.ao.myPlays();
    if (filter === 'core') plays = plays.filter(p => p.bet_category !== 'exotic');
    else if (filter === 'exotic') plays = plays.filter(p => p.bet_category === 'exotic');
    else if (filter === 'pending') plays = plays.filter(p => p.status === 'pending');
    else if (filter === 'W') plays = plays.filter(p => p.status === 'win');
    else if (filter === 'L') plays = plays.filter(p => p.status === 'loss');

    const listEl = document.getElementById('log-list');
    if (!listEl) return;
    if (!plays.length) {
      listEl.innerHTML = '<div class="empty" style="padding:16px;color:var(--text3);font-size:13px;">No plays match filter.</div>';
      return;
    }
    listEl.innerHTML = plays.map((p, i) => {
      const result = p.status === 'win' ? 'W' : p.status === 'loss' ? 'L' : null;
      let pnlHtml = '';
      if (result === 'W') pnlHtml = `<span style="color:var(--green,#26a269);font-weight:500;font-family:var(--mono);font-size:10px;">${fmtMoney(p.pnl)}</span>`;
      else if (result === 'L') pnlHtml = `<span style="color:var(--red,#c53030);font-weight:500;font-family:var(--mono);font-size:10px;">${fmtMoney(p.pnl)}</span>`;
      const typeBadge = p.bet_category === 'exotic'
        ? `<span class="log-type-badge log-type-exotic">EXOTIC</span>`
        : `<span class="log-type-badge log-type-core">CORE</span>`;
      const idx = window.ao.myPlays().findIndex(x => x.id === p.id);
      return `<div class="log-row" data-id="${p.id}">
        <div style="flex:1;min-width:0;">
          <div class="log-game">${escapeHtml(p.game)} ${pnlHtml}</div>
          <div class="log-meta">${escapeHtml(p.selection)} ${fmtOdds(p.odds)} · $${escapeHtml(p.stake)} · ${escapeHtml(fmtDate(p.play_date))} ${typeBadge}</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:4px;flex-shrink:0;">
          <button class="log-result-btn ${result==='W'?'win':'pending'}" onclick="updateLogResult(${idx},'W')">W</button>
          <button class="log-result-btn ${result==='L'?'loss':'pending'}" onclick="updateLogResult(${idx},'L')">L</button>
        </div>
      </div>`;
    }).join('');
  }

  // ─── render: Action's Plays section ──────────────────────────────────────
  function renderActionsPlays() {
    const stats = document.getElementById('actions-plays-stats');
    const list = document.getElementById('actions-plays-list');
    if (!stats || !list) return;

    const plays = window.ao.actionsPlays();
    const summary = window.ao.summaryByCategory(plays);
    const bankrolls = window.ao.actionsBankroll() || [];
    const totalCurrent = bankrolls.reduce((a, b) => a + (Number(b.current_bankroll) || 0), 0);
    const totalStarting = bankrolls.reduce((a, b) => a + (Number(b.starting_bankroll) || 0), 0);
    const bankrollDelta = totalCurrent - totalStarting;

    stats.innerHTML = `
      <div><span style="color:var(--text3);">Cumulative:</span> <strong>${summary.combined.wins}W-${summary.combined.losses}L</strong> (${summary.combined.winPct}%)</div>
      <div><span style="color:var(--text3);">Core P&L:</span> <strong style="color:${summary.core.pnl>=0?'var(--green,#26a269)':'var(--red,#c53030)'};">${fmtMoney(summary.core.pnl)}</strong></div>
      <div><span style="color:var(--text3);">Exotic:</span> <strong style="color:${summary.exotic.pnl>=0?'var(--gold,#d4af37)':'var(--red,#c53030)'};">${fmtMoney(summary.exotic.pnl)}</strong></div>
      ${bankrolls.length ? `<div><span style="color:var(--text3);">Bankroll:</span> <strong>$${Math.round(totalCurrent).toLocaleString()}</strong> <span style="color:${bankrollDelta>=0?'var(--green,#26a269)':'var(--red,#c53030)'};font-size:11px;">(${fmtMoney(bankrollDelta)})</span></div>` : ''}
    `;

    if (!plays.length) {
      list.innerHTML = '<div class="empty" style="padding:16px;color:var(--text3);font-size:13px;">No Action\'s Plays yet.</div>';
      return;
    }

    const isAdmin = window.ao.isAdmin();
    list.innerHTML = plays.slice(0, 30).map(p => {
      const result = p.status === 'win' ? 'W' : p.status === 'loss' ? 'L' : null;
      let pnlHtml = '';
      if (result === 'W') pnlHtml = `<span style="color:var(--green,#26a269);font-family:var(--mono);font-size:10px;">${fmtMoney(p.pnl)}</span>`;
      else if (result === 'L') pnlHtml = `<span style="color:var(--red,#c53030);font-family:var(--mono);font-size:10px;">${fmtMoney(p.pnl)}</span>`;
      const adminCtrls = isAdmin ? `
        <div style="display:flex;flex-direction:column;gap:4px;margin-left:8px;">
          <button onclick="window.aoAdmin.gradeActionsPlay('${p.id}','win')" style="background:transparent;border:1px solid var(--green,#26a269);color:var(--green,#26a269);padding:2px 8px;border-radius:3px;cursor:pointer;font-size:10px;">W</button>
          <button onclick="window.aoAdmin.gradeActionsPlay('${p.id}','loss')" style="background:transparent;border:1px solid var(--red,#c53030);color:var(--red,#c53030);padding:2px 8px;border-radius:3px;cursor:pointer;font-size:10px;">L</button>
          <button onclick="window.aoAdmin.deleteActionsPlay('${p.id}')" style="background:transparent;border:1px solid var(--border2,#2a3447);color:var(--text3);padding:2px 8px;border-radius:3px;cursor:pointer;font-size:10px;">×</button>
        </div>
      ` : '';
      return `<div style="display:flex;align-items:flex-start;padding:8px 4px;border-bottom:1px solid rgba(42,52,71,0.4);">
        <div style="flex:1;min-width:0;">
          <div style="font-weight:500;font-size:13px;">${escapeHtml(p.game)} ${pnlHtml}</div>
          <div style="font-size:11px;color:var(--text3,#6b7488);">${escapeHtml(p.selection)} ${fmtOdds(p.odds)} · $${escapeHtml(p.stake)} · ${escapeHtml(p.sport_id.toUpperCase())} · ${escapeHtml(fmtDate(p.play_date))} ${p.bet_category==='exotic'?'· EXOTIC':''}</div>
        </div>
        ${adminCtrls}
      </div>`;
    }).join('');
  }

  // ─── render: summary stats (replace hardcoded baselines) ─────────────────
  function renderSummaries() {
    const summary = window.ao.summaryByCategory(window.ao.myPlays());
    const bk = window.ao.myBankroll();

    const setStat = (id, value, klass) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.textContent = value;
      if (klass !== undefined) el.className = 'stat-val ' + klass;
    };

    // Core P&L — used to show $5,024 baseline + log
    setStat('s-pnl', fmtMoney(summary.core.pnl), summary.core.pnl >= 0 ? 'green' : 'red');
    setStat('s-exotic', fmtMoney(summary.exotic.pnl), summary.exotic.pnl >= 0 ? 'gold' : 'red');
    setStat('s-combined', fmtMoney(summary.combined.pnl), summary.combined.pnl >= 0 ? 'green' : 'red');

    // Records
    setStat('s-record', `${summary.combined.wins}-${summary.combined.losses}`);
    setStat('s-pct', summary.combined.winPct + '%');
    setStat('s-pending', summary.combined.pending);

    // Bankroll — show user's actual bankroll (not Kenny's)
    const bankEl = document.getElementById('cfg-bankroll-display') || document.querySelector('[data-bankroll-display]');
    if (bankEl) bankEl.textContent = '$' + Math.round(bk.current).toLocaleString();

    // Old code wrote bankroll into a span in the cfg modal too
    const cfgBankInput = document.getElementById('cfg-bankroll');
    if (cfgBankInput && !cfgBankInput.dataset.userTouched) {
      cfgBankInput.value = Math.round(bk.current);
    }
  }

  function renderAll() {
    renderMyPlays('all');
    renderActionsPlays();
    renderSummaries();
  }

  // ─── admin: add Action's Play modal ──────────────────────────────────────
  function openAddActionsPlay(existing) {
    const e = existing || null;
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:9999;padding:16px;';
    modal.innerHTML = `
      <div style="background:var(--panel,#121826);border:1px solid var(--border2,#2a3447);border-radius:10px;padding:24px;max-width:480px;width:100%;color:var(--text,#e8ebf1);font-family:'Barlow Condensed',sans-serif;">
        <h3 style="font-family:'Bebas Neue',sans-serif;font-size:22px;color:var(--gold,#d4af37);margin:0 0 16px;">${e?'Edit':'Add'} Action's Play</h3>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
          <label style="grid-column:span 2;font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:0.06em;">Game<input id="ap-game" placeholder="NYY @ HOU" value="${e?escapeHtml(e.game):''}" style="display:block;width:100%;margin-top:4px;padding:8px;background:#0f1422;border:1px solid var(--border2,#2a3447);color:var(--text);border-radius:4px;font-family:inherit;"></label>
          <label style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:0.06em;">Sport<select id="ap-sport" style="display:block;width:100%;margin-top:4px;padding:8px;background:#0f1422;border:1px solid var(--border2,#2a3447);color:var(--text);border-radius:4px;font-family:inherit;"><option value="mlb">MLB</option><option value="nhl">NHL</option><option value="nba">NBA</option><option value="nfl">NFL</option><option value="golf">Golf</option></select></label>
          <label style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:0.06em;">Date<input id="ap-date" type="date" value="${e?e.play_date:new Date().toISOString().slice(0,10)}" style="display:block;width:100%;margin-top:4px;padding:8px;background:#0f1422;border:1px solid var(--border2,#2a3447);color:var(--text);border-radius:4px;font-family:inherit;"></label>
          <label style="grid-column:span 2;font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:0.06em;">Bet Type<input id="ap-bet-type" placeholder="ML / RL / Total" value="${e?escapeHtml(e.bet_type):'ML'}" style="display:block;width:100%;margin-top:4px;padding:8px;background:#0f1422;border:1px solid var(--border2,#2a3447);color:var(--text);border-radius:4px;font-family:inherit;"></label>
          <label style="grid-column:span 2;font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:0.06em;">Selection<input id="ap-selection" placeholder="NYY ML" value="${e?escapeHtml(e.selection):''}" style="display:block;width:100%;margin-top:4px;padding:8px;background:#0f1422;border:1px solid var(--border2,#2a3447);color:var(--text);border-radius:4px;font-family:inherit;"></label>
          <label style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:0.06em;">Odds<input id="ap-odds" type="number" placeholder="-150 / +130" value="${e?e.odds:''}" style="display:block;width:100%;margin-top:4px;padding:8px;background:#0f1422;border:1px solid var(--border2,#2a3447);color:var(--text);border-radius:4px;font-family:inherit;"></label>
          <label style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:0.06em;">Stake $<input id="ap-stake" type="number" step="0.01" placeholder="200" value="${e?e.stake:''}" style="display:block;width:100%;margin-top:4px;padding:8px;background:#0f1422;border:1px solid var(--border2,#2a3447);color:var(--text);border-radius:4px;font-family:inherit;"></label>
          <label style="grid-column:span 2;font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:0.06em;">Category<select id="ap-cat" style="display:block;width:100%;margin-top:4px;padding:8px;background:#0f1422;border:1px solid var(--border2,#2a3447);color:var(--text);border-radius:4px;font-family:inherit;"><option value="core">Core</option><option value="exotic">Exotic</option></select></label>
          <label style="grid-column:span 2;font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:0.06em;">Notes (optional)<textarea id="ap-notes" rows="2" style="display:block;width:100%;margin-top:4px;padding:8px;background:#0f1422;border:1px solid var(--border2,#2a3447);color:var(--text);border-radius:4px;font-family:inherit;resize:vertical;">${e?escapeHtml(e.notes||''):''}</textarea></label>
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;">
          <button id="ap-cancel" style="background:transparent;border:1px solid var(--border2,#2a3447);color:var(--text2);padding:8px 16px;border-radius:5px;cursor:pointer;font-family:inherit;">Cancel</button>
          <button id="ap-save" style="background:var(--gold,#d4af37);border:none;color:#0a0e1a;padding:8px 18px;border-radius:5px;cursor:pointer;font-family:'Bebas Neue',sans-serif;letter-spacing:0.06em;">${e?'Save':'Publish'}</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    if (e) document.getElementById('ap-sport').value = e.sport_id;
    if (e) document.getElementById('ap-cat').value = e.bet_category || 'core';

    document.getElementById('ap-cancel').addEventListener('click', () => modal.remove());
    document.getElementById('ap-save').addEventListener('click', async () => {
      const payload = {
        game: document.getElementById('ap-game').value.trim(),
        sport_id: document.getElementById('ap-sport').value,
        play_date: document.getElementById('ap-date').value,
        bet_type: document.getElementById('ap-bet-type').value.trim() || 'ML',
        selection: document.getElementById('ap-selection').value.trim(),
        odds: parseInt(document.getElementById('ap-odds').value, 10),
        stake: parseFloat(document.getElementById('ap-stake').value),
        bet_category: document.getElementById('ap-cat').value,
        notes: document.getElementById('ap-notes').value.trim() || null,
      };
      if (!payload.game || !payload.selection || isNaN(payload.odds) || isNaN(payload.stake)) {
        alert('Game, selection, odds, and stake are required.');
        return;
      }
      try {
        if (e) await window.ao.updateActionsPlay(e.id, payload);
        else await window.ao.addActionsPlay(payload);
        modal.remove();
        renderActionsPlays();
      } catch (err) { alert('Failed: ' + err.message); }
    });
  }

  // ─── admin: grade / delete Action's Plays from the inline list ──────────
  window.aoAdmin = {
    gradeActionsPlay: async (id, status) => {
      try { await window.ao.updateActionsPlay(id, { status }); renderActionsPlays(); }
      catch (err) { alert('Failed: ' + err.message); }
    },
    deleteActionsPlay: async (id) => {
      if (!confirm('Delete this play?')) return;
      try { await window.ao.deleteActionsPlay(id); renderActionsPlays(); }
      catch (err) { alert('Failed: ' + err.message); }
    },
    openEditActionsPlay: (id) => {
      const p = window.ao.actionsPlays().find(x => x.id === id);
      if (p) openAddActionsPlay(p);
    },
  };
})();
