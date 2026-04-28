/**
 * Action's Odds — Sharing Detection Cron (Phase 2c)
 *
 * Runs every 30 minutes inside the main server process. For each user with
 * login activity since the last run, runs:
 *   - analyzeMultiGeo (3+ distinct regions in 14 days)
 *   - analyzeConcurrentUse (2+ active sessions from different ASN/region)
 *
 * Records new flags to sharing_flags table. If any new flags appeared in
 * this tick, sends a digest email to the admin alert address.
 *
 * Dedupe: skips creating a new flag if the same user has the same flag_type
 * already recorded in the last 24 hours. Prevents flag spam on a single
 * sharing case.
 */

const { supabaseAdmin } = require('./auth');
const { analyzeMultiGeo, analyzeConcurrentUse, recordFlag } = require('./sharing-detection');

// Optional email module — if email setup isn't done, cron still runs and just
// skips notifications.
let email;
try { email = require('./email'); } catch { email = null; }

const RUN_INTERVAL_MS = 30 * 60 * 1000; // 30 min
const FIRST_RUN_DELAY_MS = 5 * 60 * 1000; // wait 5 min after boot
const DEDUPE_HOURS = 24;
const MAX_USERS_PER_TICK = 100; // safety cap

const ADMIN_ALERT_EMAIL = process.env.ADMIN_ALERT_EMAIL || 'actionkg@aol.com';

// ─── Helper: read+update the cron cursor ─────────────────────────────────
async function getLastRun() {
  const { data } = await supabaseAdmin
    .from('sharing_cron_state')
    .select('last_run_at')
    .eq('id', 1)
    .maybeSingle();
  return data?.last_run_at || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
}

async function setLastRun(when) {
  await supabaseAdmin
    .from('sharing_cron_state')
    .update({ last_run_at: when })
    .eq('id', 1);
}

// ─── Helper: dedupe — has this user been flagged for this same reason recently? ──
async function alreadyRecentlyFlagged(userId, flagType) {
  const since = new Date(Date.now() - DEDUPE_HOURS * 60 * 60 * 1000).toISOString();
  const { data } = await supabaseAdmin
    .from('sharing_flags')
    .select('id')
    .eq('user_id', userId)
    .eq('flag_type', flagType)
    .gte('created_at', since)
    .limit(1);
  return (data || []).length > 0;
}

// ─── Helper: who logged in since the last cron run? ─────────────────────
async function getActiveUsers(since) {
  const { data } = await supabaseAdmin
    .from('login_events')
    .select('user_id')
    .eq('event_type', 'login_success')
    .gte('created_at', since)
    .not('user_id', 'is', null)
    .limit(MAX_USERS_PER_TICK * 5); // dedupe to MAX_USERS_PER_TICK below

  const set = new Set();
  for (const row of (data || [])) {
    if (row.user_id) set.add(row.user_id);
    if (set.size >= MAX_USERS_PER_TICK) break;
  }
  return Array.from(set);
}

// ─── Main tick ──────────────────────────────────────────────────────────
async function runOnce() {
  const startedAt = new Date().toISOString();
  const lastRun = await getLastRun();
  const userIds = await getActiveUsers(lastRun);

  if (userIds.length === 0) {
    await setLastRun(startedAt);
    return { scanned: 0, flagged: 0 };
  }

  console.log(`[sharing-cron] scanning ${userIds.length} active user(s) since ${lastRun}`);

  const newFlags = [];
  for (const userId of userIds) {
    try {
      const multi = await analyzeMultiGeo(userId);
      if (multi && !(await alreadyRecentlyFlagged(userId, multi.flag_type))) {
        await recordFlag(userId, multi);
        newFlags.push({ userId, ...multi });
      }

      const concurrent = await analyzeConcurrentUse(userId);
      if (concurrent && !(await alreadyRecentlyFlagged(userId, concurrent.flag_type))) {
        await recordFlag(userId, concurrent);
        newFlags.push({ userId, ...concurrent });
      }
    } catch (err) {
      console.error(`[sharing-cron] user ${userId} failed:`, err.message);
    }
  }

  await setLastRun(startedAt);
  console.log(`[sharing-cron] done. ${newFlags.length} new flag(s) recorded`);

  if (newFlags.length > 0) {
    await sendDigest(newFlags);
  }

  return { scanned: userIds.length, flagged: newFlags.length };
}

// ─── Digest email to admin ──────────────────────────────────────────────
async function sendDigest(flags) {
  if (!email || !email.sendAdminFlagDigest) {
    console.log(`[sharing-cron] ${flags.length} flag(s) — admin digest skipped (email module missing)`);
    return;
  }

  // Hydrate user emails for the digest
  const userIds = [...new Set(flags.map(f => f.userId))];
  const { data: users } = await supabaseAdmin
    .schema('auth')
    .from('users')
    .select('id, email')
    .in('id', userIds);
  const emailMap = new Map((users || []).map(u => [u.id, u.email]));

  const enriched = flags.map(f => ({
    ...f,
    userEmail: emailMap.get(f.userId) || '(unknown email)',
  }));

  try {
    await email.sendAdminFlagDigest({
      to: ADMIN_ALERT_EMAIL,
      flags: enriched,
    });
    console.log(`[sharing-cron] admin digest sent to ${ADMIN_ALERT_EMAIL}`);
  } catch (err) {
    console.error('[sharing-cron] digest email failed:', err.message);
  }
}

// ─── Bootstrapping ──────────────────────────────────────────────────────
function start() {
  console.log(`[sharing-cron] scheduled — first tick in ${Math.round(FIRST_RUN_DELAY_MS / 60000)}min, then every ${RUN_INTERVAL_MS / 60000}min`);

  setTimeout(() => {
    runOnce().catch(err => console.error('[sharing-cron] tick failed:', err));
    setInterval(() => {
      runOnce().catch(err => console.error('[sharing-cron] tick failed:', err));
    }, RUN_INTERVAL_MS);
  }, FIRST_RUN_DELAY_MS);
}

module.exports = { start, runOnce };
