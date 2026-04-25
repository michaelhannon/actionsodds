/**
 * Action's Odds — Stripe webhook handler
 *
 * Listens for these events from Stripe and writes to subscriptions table:
 *   - checkout.session.completed       → user just paid; create subscription rows
 *   - customer.subscription.updated    → status change, renewal, etc.
 *   - customer.subscription.deleted    → cancellation
 *   - invoice.payment_failed           → mark past_due
 *
 * Env vars:
 *   STRIPE_SECRET_KEY        sk_test_... or sk_live_...
 *   STRIPE_WEBHOOK_SECRET    whsec_... (from Stripe Dashboard webhook page)
 *
 * Mount in main server.js:
 *   const { stripeWebhookHandler } = require('./server/stripe-webhook');
 *   app.post('/api/stripe/webhook',
 *     express.raw({ type: 'application/json' }),
 *     stripeWebhookHandler
 *   );
 *
 * IMPORTANT: the webhook route MUST receive the raw body, not parsed JSON.
 * That's why the express.raw middleware is on this route specifically.
 */

const Stripe = require('stripe');
const { supabaseAdmin } = require('./auth');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

async function stripeWebhookHandler(req, res) {
  let event;
  try {
    const sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(req.body, sig, WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log(`[stripe-webhook] received: ${event.type}`);

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(event.data.object);
        break;
      case 'customer.subscription.updated':
      case 'customer.subscription.created':
        await handleSubscriptionUpdated(event.data.object);
        break;
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object);
        break;
      case 'invoice.payment_failed':
        await handlePaymentFailed(event.data.object);
        break;
      default:
        console.log(`[stripe-webhook] unhandled event type: ${event.type}`);
    }
  } catch (err) {
    console.error('[stripe-webhook] handler error:', err);
    return res.status(500).send('Handler failed');
  }

  res.json({ received: true });
}

/* ─────────────── HANDLERS ─────────────── */

async function handleCheckoutCompleted(session) {
  // User just completed Stripe Checkout. We attached a `user_id` and
  // `sport_ids` array to the session metadata when creating it.
  const userId = session.metadata?.user_id;
  const sportIds = (session.metadata?.sport_ids || '').split(',').filter(Boolean);
  const isBundle = session.metadata?.is_bundle === 'true';
  const cadence = session.metadata?.cadence;

  if (!userId || sportIds.length === 0) {
    console.warn('[stripe-webhook] checkout.session.completed missing metadata', session.id);
    return;
  }

  // Pull the subscription details
  const subscription = await stripe.subscriptions.retrieve(session.subscription);

  // For each sport the user paid for, upsert a subscriptions row
  for (const sportId of sportIds) {
    await supabaseAdmin.from('subscriptions').upsert({
      user_id: userId,
      sport_id: sportId,
      cadence,
      is_bundle: isBundle,
      status: subscription.status,
      stripe_subscription_id: subscription.id,
      stripe_customer_id: subscription.customer,
      current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
      cancel_at_period_end: subscription.cancel_at_period_end,
    }, { onConflict: 'user_id,sport_id' });
  }
  console.log(`[stripe-webhook] activated ${sportIds.length} sport(s) for user ${userId}`);
}

async function handleSubscriptionUpdated(subscription) {
  // Find all our DB rows tied to this Stripe subscription
  const { data: rows } = await supabaseAdmin
    .from('subscriptions')
    .select('user_id, sport_id')
    .eq('stripe_subscription_id', subscription.id);

  if (!rows || rows.length === 0) {
    console.warn(`[stripe-webhook] no rows for stripe sub ${subscription.id}`);
    return;
  }

  for (const row of rows) {
    await supabaseAdmin.from('subscriptions').update({
      status: subscription.status,
      current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
      cancel_at_period_end: subscription.cancel_at_period_end,
    }).eq('user_id', row.user_id).eq('sport_id', row.sport_id);
  }
}

async function handleSubscriptionDeleted(subscription) {
  await supabaseAdmin.from('subscriptions').update({ status: 'canceled' })
    .eq('stripe_subscription_id', subscription.id);
}

async function handlePaymentFailed(invoice) {
  const subId = invoice.subscription;
  if (!subId) return;
  await supabaseAdmin.from('subscriptions').update({ status: 'past_due' })
    .eq('stripe_subscription_id', subId);
}

module.exports = { stripeWebhookHandler };
