/**
 * Action's Odds — Stripe Customer Billing Portal
 *
 * POST /api/stripe/billing-portal
 *
 * Returns a one-time URL that lands the user on Stripe's hosted billing portal
 * where they can update payment method, cancel subscription, see invoices, etc.
 *
 * Requires: an existing Stripe customer (created when the user completed
 * Checkout). We look up the customer ID from the user's most recent active
 * subscription.
 */

const Stripe = require('stripe');
const { supabaseAdmin } = require('./auth');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

async function createBillingPortalSession(req, res) {
  try {
    const userId = req.user.id;

    // Find a subscription for this user — any status — to grab the Stripe customer ID
    const { data, error } = await supabaseAdmin
      .from('subscriptions')
      .select('stripe_customer_id')
      .eq('user_id', userId)
      .not('stripe_customer_id', 'is', null)
      .limit(1)
      .maybeSingle();

    if (error || !data?.stripe_customer_id) {
      return res.status(404).json({ error: 'No billing account found. Subscribe first to manage billing.' });
    }

    const baseUrl = process.env.PUBLIC_URL || 'https://www.actionsodds.com';
    const session = await stripe.billingPortal.sessions.create({
      customer: data.stripe_customer_id,
      return_url: `${baseUrl}/account.html`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('createBillingPortalSession error:', err);
    res.status(500).json({ error: err.message });
  }
}

module.exports = { createBillingPortalSession };
