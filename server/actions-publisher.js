/**
 * Action's Odds — Auto-publisher
 *
 * After every morning scan, push qualifying plays (MAX/STRONG/ENTRY) into
 * the `actions_plays` Supabase table so the front-end can render Kenny's
 * head-to-head vs the user's ledger.
 *
 * Design:
 *   - Server-side only — uses supabaseAdmin (service role) so RLS is bypassed.
 *   - Idempotent — relies on a unique index on (play_date, game, selection).
 *     If the same scan runs twice, the second insert is a no-op.
 *   - Stake is recorded as UNITS (engine output `analysis.units`), priced
 *     against the global $10,000 reference bankroll. The UI scales per user.
 *   - Status starts as 'pending'. The grader (actions-grader.js) updates it.
 *
 * Bet category:
 *   - 'core' for T1, T11, T12 plays
 *   - 'exotic' for T13, T15, run-line add-ons (currently we don't auto-publish
 *     run-line add-ons — they're flagged in scan output but require manual
 *     trigger by Kenny since they sit alongside the moneyline play)
 */

const { supabaseAdmin } = require('./auth');

// $ value of one unit at the reference $10K bankroll.
// engine outputs `analysis.sizing = units * 100`, which equals stake at $10K.
const REFERENCE_BANKROLL = 10000;
const STAKE_PER_UNIT = REFERENCE_BANKROLL * 0.01; // 1% per unit = $100

const PUBLISHABLE_STRENGTHS = new Set(['MAX', 'STRONG', 'ENTRY']);

/**
 * Convert a single scan play into an actions_plays row.
 * Returns null if the play shouldn't be published.
 */
function playToRow(scanPlay) {
  const a = scanPlay.analysis || {};
  if (!PUBLISHABLE_STRENGTHS.has(a.strength)) return null;
  if (!a.units || a.units <= 0) return null;
  if (a.t14Kill || a.t15Active || a.t3Kill) return null;
  if (!a.gateType || a.gateML == null) return null;

  // Side names — gateSide tells us home or away
  const sideTeam = a.gateSide === 'home' ? scanPlay.home?.name : scanPlay.away?.name;
  if (!sideTeam) return null;

  // play_date in ET (East Coast play day). The scan runs at 9AM ET so
  // gameTime is always today ET; format as YYYY-MM-DD using the gameTime.
  const playDate = new Date(scanPlay.gameTime).toLocaleDateString('en-CA', {
    timeZone: 'America/New_York',
  });

  // bet_category: T13/T15 = exotic, others = core
  const exoticGates = new Set(['T13', 'T15']);
  const betCategory = exoticGates.has(a.gateType) ? 'exotic' : 'core';

  const oddsStr = a.gateML > 0 ? `+${a.gateML}` : `${a.gateML}`;
  const stake = Number((a.units * STAKE_PER_UNIT).toFixed(2));

  // Notes: capture trigger info so it's auditable later
  const triggers = (a.triggered || []).map(t => t.code || t.name || t).filter(Boolean);
  const notes = [
    `${a.gateType} | ${a.strength} | ${a.units}u`,
    triggers.length ? `triggers: ${triggers.join(',')}` : null,
  ].filter(Boolean).join(' • ').slice(0, 1000);

  return {
    sport_id: 'mlb',
    play_date: playDate,
    game: scanPlay.game,                              // "Away Name @ Home Name"
    bet_type: 'ML',
    selection: `${sideTeam} ${oddsStr}`,              // "Milwaukee Brewers +145"
    odds: a.gateML,
    stake,
    status: 'pending',
    pnl: 0,
    bet_category: betCategory,
    notes,
  };
}

/**
 * Publish all qualifying plays from a scan to actions_plays.
 * Returns { inserted, skipped, errors }.
 *
 * Idempotency: assumes a UNIQUE constraint on (play_date, game, selection).
 * If the index isn't present this still runs but may double-insert on re-runs;
 * see /db/2026-04-27-actions-plays-unique.sql for the migration.
 */
async function publishScanPlays(scan) {
  if (!scan || !Array.isArray(scan.plays)) {
    return { inserted: 0, skipped: 0, errors: ['scan has no plays array'] };
  }

  const rows = scan.plays.map(playToRow).filter(Boolean);
  if (rows.length === 0) {
    return { inserted: 0, skipped: 0, errors: [] };
  }

  // Use upsert with onConflict to make this safe to re-run on the same scan.
  // We DO NOT update existing rows — once a play is published we leave it
  // alone (Kenny may have edited odds/stake manually). ignoreDuplicates: true.
  const { data, error } = await supabaseAdmin
    .from('actions_plays')
    .upsert(rows, {
      onConflict: 'play_date,game,selection',
      ignoreDuplicates: true,
    })
    .select();

  if (error) {
    console.error('[Publisher] Upsert failed:', error.message);
    // Fall back to per-row insert so one bad row doesn't kill the batch.
    const results = await Promise.allSettled(
      rows.map(r =>
        supabaseAdmin.from('actions_plays').insert(r).select().single()
      )
    );
    let inserted = 0, skipped = 0;
    const errors = [];
    for (const r of results) {
      if (r.status === 'fulfilled') inserted++;
      else if (r.reason?.code === '23505') skipped++; // unique violation
      else errors.push(r.reason?.message || String(r.reason));
    }
    return { inserted, skipped, errors };
  }

  const inserted = (data || []).length;
  const skipped = rows.length - inserted;
  console.log(`[Publisher] ${inserted} new plays published, ${skipped} already on the books`);
  return { inserted, skipped, errors: [] };
}

module.exports = { publishScanPlays, playToRow };
