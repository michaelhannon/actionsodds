/**
 * Action's Odds — Stripe webhook handler
 *
 * Listens for these events from Stripe and writes to subscriptions table:
 *   - checkout.session.completed       → user just paid; create subscription rows
 *   - customer.subscription.updated    → status change, renewal, etc.
 *   - customer.subscription.deleted    → cancellation
 *   - invoice.payment_failed           → mark past_due
 *
 * Phase 2b additions:
 *   - On subscription.deleted / past_due / unpaid, revoke all of the user's
 *     active sessions and send a "subscription ended" email. This closes
 *     the "cancel sub but keep using it" loophole.
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
const sessions = require('./sessions');
const email = require('./email');

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

  // ─── Phase 2b: revoke sessions on lapsed/unpaid status ───
  // 'unpaid' or 'incomplete_expired' = Stripe gave up retrying. Kick them out.
  if (['unpaid', 'incomplete_expired'].includes(subscription.status)) {
    await revokeUserAndNotify(rows[0].user_id, rows[0].sport_id, subscription.status);
  }
}

async function handleSubscriptionDeleted(subscription) {
  // Find user(s) BEFORE we update — we need the user_id for session revocation
  const { data: rows } = await supabaseAdmin
    .from('subscriptions')
    .select('user_id, sport_id')
    .eq('stripe_subscription_id', subscription.id);

  await supabaseAdmin.from('subscriptions').update({ status: 'canceled' })
    .eq('stripe_subscription_id', subscription.id);

  // ─── Phase 2b: revoke the user's sessions ────────────────
  if (rows && rows.length > 0) {
    await revokeUserAndNotify(rows[0].user_id, rows[0].sport_id, 'canceled');
  }
}

async function handlePaymentFailed(invoice) {
  const subId = invoice.subscription;
  if (!subId) return;
  await supabaseAdmin.from('subscriptions').update({ status: 'past_due' })
    .eq('stripe_subscription_id', subId);

  // We don't revoke sessions on FIRST payment failure — Stripe retries for
  // 1-3 weeks via dunning. We only revoke when it goes to unpaid/canceled
  // (handled in the other handlers above).
}

/**
 * Phase 2b helper: revoke all sessions for the user whose subscription
 * just lapsed / canceled / went unpaid. Send them an email letting them
 * know they've been signed out.
 *
 * Best-effort — if any step fails, we log and move on. The webhook itself
 * still returns 200 to Stripe, since the subscription state IS updated.
 */
async function revokeUserAndNotify(userId, sportId, status) {
  try {
    // Check if the user has ANY other active subscriptions before revoking.
    // If they're paying for MLB but cancel NHL, don't kick them out.
    const { data: stillActive } = await supabaseAdmin
      .from('subscriptions')
      .select('id')
      .eq('user_id', userId)
      .eq('status', 'active')
      .limit(1);

    if (stillActive && stillActive.length > 0) {
      console.log(`[stripe-webhook] user ${userId} still has active subs — skipping revoke`);
      return;
    }

    await sessions.revokeAllUserSessions(userId, `subscription_${status}`);
    console.log(`[stripe-webhook] revoked sessions for user ${userId} (${status})`);

    // Get email + send notification
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('email')
      .eq('user_id', userId)
      .maybeSingle();

    if (profile?.email) {
      email.sendSubscriptionEndedAlert({ to: profile.email, sport: sportId })
        .catch(err => console.error('[stripe-webhook] email failed:', err.message));
    }
  } catch (err) {
    console.error('[stripe-webhook] revokeUserAndNotify failed:', err.message);
  }
}

module.exports = { stripeWebhookHandler };
