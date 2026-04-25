/**
 * Action's Odds — Stripe price creation script
 *
 * Creates all 30 Stripe Price objects for the SaaS:
 *   5 sports × 3 cadences × 2 modes (individual / part-of-bundle)
 *   Plus 3 all-sports bundle prices (one per cadence)
 *
 * Run once locally:
 *    cd ~/Downloads/actionsodds
 *    node scripts/setup-stripe.js
 *
 * Outputs price IDs to: scripts/stripe-prices.json
 * That JSON is then read by the server when starting Checkout sessions.
 *
 * Re-running this script is SAFE — it checks for existing products
 * by metadata key and won't create duplicates.
 *
 * Pricing structure (USD, all in cents for Stripe):
 *   Individual sport:
 *     Weekly:  $10.00   = 1000
 *     Monthly: $30.00   = 3000
 *     Yearly:  $281.00  = 28100   (≈22% off vs monthly × 12)
 *
 *   All-Sports Bundle (5 sports, 25% off the sum):
 *     Weekly:  $10×5×0.75   = $37.50  = 3750
 *     Monthly: $30×5×0.75   = $112.50 = 11250
 *     Yearly:  $281×5×0.75  = $1053.75 = 105375
 */

const Stripe = require('stripe');

const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
if (!STRIPE_KEY) {
  console.error('ERROR: STRIPE_SECRET_KEY not set in environment.');
  console.error('Run: STRIPE_SECRET_KEY=sk_test_... node scripts/setup-stripe.js');
  process.exit(1);
}
const stripe = new Stripe(STRIPE_KEY, { apiVersion: '2024-06-20' });

const SPORTS = [
  { id: 'mlb',  name: 'MLB' },
  { id: 'nhl',  name: 'NHL' },
  { id: 'nba',  name: 'NBA' },
  { id: 'nfl',  name: 'NFL' },
  { id: 'golf', name: 'Golf' },
];

// Cadences and their amounts in CENTS
// Stripe uses smallest currency unit (cents for USD)
const CADENCES = {
  weekly:  { interval: 'week',  interval_count: 1, individual: 1000,   bundle: 3750   },
  monthly: { interval: 'month', interval_count: 1, individual: 3000,   bundle: 11250  },
  yearly:  { interval: 'year',  interval_count: 1, individual: 28100,  bundle: 105375 },
};

// Lookup keys we attach to each price for idempotency
// If a price with this lookup_key already exists, we reuse it
function lookupKey(sportId, cadence, isBundle) {
  if (isBundle) return `bundle_${cadence}`;
  return `${sportId}_${cadence}_individual`;
}

async function findOrCreateProduct(name, metadata) {
  // Try to find existing product by metadata
  const existing = await stripe.products.list({ limit: 100, active: true });
  const match = existing.data.find(p =>
    Object.entries(metadata).every(([k, v]) => p.metadata[k] === v)
  );
  if (match) {
    console.log(`  ✓ Product exists: ${name} (${match.id})`);
    return match;
  }
  const product = await stripe.products.create({ name, metadata });
  console.log(`  + Created product: ${name} (${product.id})`);
  return product;
}

async function findOrCreatePrice(productId, lookupKeyVal, amount, cadenceConfig) {
  // Look up by lookup_key (idempotent)
  const existing = await stripe.prices.list({
    lookup_keys: [lookupKeyVal],
    active: true,
    limit: 1,
  });
  if (existing.data.length > 0) {
    console.log(`    ✓ Price exists: ${lookupKeyVal} ($${(amount/100).toFixed(2)} ${cadenceConfig.interval}ly)`);
    return existing.data[0];
  }
  const price = await stripe.prices.create({
    product: productId,
    unit_amount: amount,
    currency: 'usd',
    recurring: {
      interval: cadenceConfig.interval,
      interval_count: cadenceConfig.interval_count,
    },
    lookup_key: lookupKeyVal,
    metadata: { lookup_key: lookupKeyVal },
  });
  console.log(`    + Created price: ${lookupKeyVal} ($${(amount/100).toFixed(2)} ${cadenceConfig.interval}ly)`);
  return price;
}

async function main() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log("Action's Odds — Stripe price setup");
  console.log(`Mode: ${STRIPE_KEY.startsWith('sk_test_') ? 'TEST' : 'LIVE'} ⚠`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const prices = {
    individual: {},  // { mlb: { weekly, monthly, yearly }, ... }
    bundle: {},      // { weekly, monthly, yearly }
  };

  // ─── Individual sport products + prices (5 × 3 = 15) ───
  console.log('Creating individual sport prices...\n');
  for (const sport of SPORTS) {
    console.log(`▸ ${sport.name}`);
    const product = await findOrCreateProduct(
      `Action's Odds — ${sport.name}`,
      { type: 'individual', sport_id: sport.id }
    );
    prices.individual[sport.id] = {};
    for (const [cadence, cfg] of Object.entries(CADENCES)) {
      const lk = lookupKey(sport.id, cadence, false);
      const price = await findOrCreatePrice(product.id, lk, cfg.individual, cfg);
      prices.individual[sport.id][cadence] = price.id;
    }
    console.log('');
  }

  // ─── Bundle product + 3 prices ───
  console.log('Creating all-sports bundle prices...\n');
  console.log('▸ All-Sports Bundle');
  const bundleProduct = await findOrCreateProduct(
    "Action's Odds — All Sports Bundle (25% off)",
    { type: 'bundle' }
  );
  for (const [cadence, cfg] of Object.entries(CADENCES)) {
    const lk = lookupKey(null, cadence, true);
    const price = await findOrCreatePrice(bundleProduct.id, lk, cfg.bundle, cfg);
    prices.bundle[cadence] = price.id;
  }

  // ─── Write output ───
  const output = {
    mode: STRIPE_KEY.startsWith('sk_test_') ? 'test' : 'live',
    generated_at: new Date().toISOString(),
    prices,
  };
  const fs = require('fs');
  const path = require('path');
  const outPath = path.join(__dirname, 'stripe-prices.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`✓ Done. Wrote ${outPath}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('\nPrice summary:');
  console.log(JSON.stringify(prices, null, 2));
}

main().catch(err => {
  console.error('\n❌ FAILED:');
  console.error(err.message);
  if (err.raw) console.error(err.raw);
  process.exit(1);
});
