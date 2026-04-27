require('dotenv').config();
/**
 * Action's Odds — Seed Script (one-shot, idempotent)
 *
 * Run via: node server/seed-actions.js
 *
 * What it does:
 *   1. Upserts the MLB actions_bankroll row with:
 *        starting_bankroll = 10000
 *        current_bankroll  = 15509  (10000 + 5509 backfill P&L)
 *        total_wins        = 25
 *        total_losses      = 10
 *        total_pushes      = 0
 *
 *   2. Inserts ONE backfill row in actions_plays representing the +$5,509
 *      pre-launch P&L from Mar–Apr 2026 (25-10 core +$4,610, exotic +$899).
 *      This row is marked as a 'win' with the full +$5,509 baked into pnl
 *      so the head-to-head widget shows the right starting line.
 *
 * Idempotent — safe to re-run. Uses upsert + a recognizable backfill marker
 * row that's identified by play_date + selection.
 *
 * NOTE: This DOES NOT include the +$503 pre-system plays from the running
 * season ledger. If you want those folded in, change BACKFILL_PNL to 6012
 * and rerun.
 */

const { supabaseAdmin } = require('./auth');

const REFERENCE_BANKROLL = 10000;
const BACKFILL_PNL = 5509;     // $4,610 core + $899 exotic
const BACKFILL_WINS = 25;
const BACKFILL_LOSSES = 10;
const BACKFILL_DATE = '2026-04-26'; // day before launch — keeps it out of live ledger
const BACKFILL_SELECTION = 'Pre-launch backfill (25-10 core +$4,610, exotic +$899)';

async function seedBankroll() {
  // Try to fetch existing
  const { data: existing } = await supabaseAdmin
    .from('actions_bankroll')
    .select('*')
    .eq('sport_id', 'mlb')
    .maybeSingle();

  const row = {
    sport_id: 'mlb',
    starting_bankroll: REFERENCE_BANKROLL,
    current_bankroll: REFERENCE_BANKROLL + BACKFILL_PNL,
    total_wins: BACKFILL_WINS,
    total_losses: BACKFILL_LOSSES,
    total_pushes: 0,
    updated_at: new Date().toISOString(),
  };

  if (existing) {
    console.log('[Seed] MLB bankroll row exists — updating');
    const { error } = await supabaseAdmin
      .from('actions_bankroll')
      .update(row)
      .eq('sport_id', 'mlb');
    if (error) throw error;
  } else {
    console.log('[Seed] MLB bankroll row missing — inserting');
    const { error } = await supabaseAdmin
      .from('actions_bankroll')
      .insert(row);
    if (error) throw error;
  }
  console.log('[Seed] Bankroll: starting=$10,000 current=$' + row.current_bankroll +
              ' record=' + row.total_wins + '-' + row.total_losses);
}

async function seedBackfillPlay() {
  // Check if backfill row already there
  const { data: existing } = await supabaseAdmin
    .from('actions_plays')
    .select('id')
    .eq('play_date', BACKFILL_DATE)
    .eq('selection', BACKFILL_SELECTION)
    .maybeSingle();

  if (existing) {
    console.log('[Seed] Backfill play row already present (id=' + existing.id + ') — skipping');
    return;
  }

  const row = {
    sport_id: 'mlb',
    play_date: BACKFILL_DATE,
    game: 'Pre-launch ledger consolidation',
    bet_type: 'BACKFILL',
    selection: BACKFILL_SELECTION,
    odds: 100,                 // arbitrary; pnl is the source of truth
    stake: BACKFILL_PNL,       // matches pnl so even/win arithmetic is consistent
    status: 'win',
    pnl: BACKFILL_PNL,
    bet_category: 'core',
    notes: 'Pre-launch baseline. Seeded by server/seed-actions.js. ' +
           'Do not edit individually — this row consolidates 25-10 core (+$4,610) and exotic (+$899).',
  };

  const { error } = await supabaseAdmin
    .from('actions_plays')
    .insert(row);
  if (error) throw error;
  console.log('[Seed] Backfill play inserted: pnl=+$' + BACKFILL_PNL);
}

async function main() {
  try {
    await seedBankroll();
    await seedBackfillPlay();
    console.log('[Seed] Complete.');
    process.exit(0);
  } catch (e) {
    console.error('[Seed] FAILED:', e.message);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { seedBankroll, seedBackfillPlay };
