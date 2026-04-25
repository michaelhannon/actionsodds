/**
 * Action's Odds — Stripe Checkout endpoint
 *
 * POST /api/stripe/create-checkout
 * Body: { sport_ids: ['mlb','nhl',...], cadence: 'monthly' }
 *
 * Creates a Stripe Checkout session and returns the URL to redirect to.
 * If user picks all 5 sports, automatically uses the bundle pricing.
 */

const Stripe = require('stripe');
const fs = require('fs');
const path = require('path');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

// Load price IDs created by setup-stripe.js
let PRICES = null;
function loadPrices() {
  if (PRICES) return PRICES;
  const p = path.join(__dirname, '..', 'scripts', 'stripe-prices.json');
  if (!fs.existsSync(p)) {
    throw new Error('stripe-prices.json missing. Run: node scripts/setup-stripe.js');
  }
  PRICES = JSON.parse(fs.readFileSync(p, 'utf-8'));
  return PRICES;
}

const ALL_SPORTS = ['mlb', 'nhl', 'nba', 'nfl', 'golf'];

async function createCheckoutSession(req, res) {
  try {
    const { sport_ids, cadence } = req.body;
    const userId = req.user.id;
    const userEmail = req.user.email;

    // Validation
    if (!Array.isArray(sport_ids) || sport_ids.length === 0) {
      return res.status(400).json({ error: 'sport_ids must be a non-empty array' });
    }
    if (!['weekly', 'monthly', 'yearly'].includes(cadence)) {
      return res.status(400).json({ error: 'cadence must be weekly, monthly, or yearly' });
    }
    for (const s of sport_ids) {
      if (!ALL_SPORTS.includes(s)) {
        return res.status(400).json({ error: `Invalid sport: ${s}` });
      }
    }

    const prices = loadPrices().prices;
    const isBundle = sport_ids.length === ALL_SPORTS.length &&
                     ALL_SPORTS.every(s => sport_ids.includes(s));

    // Build line items
    let lineItems;
    if (isBundle) {
      lineItems = [{ price: prices.bundle[cadence], quantity: 1 }];
    } else {
      lineItems = sport_ids.map(s => ({
        price: prices.individual[s][cadence],
        quantity: 1,
      }));
    }

    const baseUrl = process.env.PUBLIC_URL || 'https://www.actionsodds.com';
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer_email: userEmail,
      line_items: lineItems,
      success_url: `${baseUrl}/?welcome=1`,
      cancel_url: `${baseUrl}/pricing.html?canceled=1`,
      metadata: {
        user_id: userId,
        sport_ids: sport_ids.join(','),
        is_bundle: isBundle.toString(),
        cadence,
      },
      subscription_data: {
        metadata: {
          user_id: userId,
          sport_ids: sport_ids.join(','),
        },
      },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('createCheckoutSession error:', err);
    res.status(500).json({ error: err.message });
  }
}

module.exports = { createCheckoutSession };
