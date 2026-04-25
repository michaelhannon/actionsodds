/**
 * Action's Odds — Auth helpers (server-side)
 *
 * Provides:
 *   - supabaseAdmin: server client with service_role privileges
 *   - requireAuth(req, res, next): Express middleware that verifies the JWT
 *     in the Authorization header. Sets req.user.
 *   - requireAdmin(req, res, next): runs after requireAuth, blocks non-admins.
 *   - requireSport(sportId): factory for middleware that blocks users who
 *     don't have an active subscription for the given sport.
 *
 * Reads from env vars:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY  (server-only, never expose to browser)
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('FATAL: SUPABASE_URL or SUPABASE_SERVICE_KEY missing from env.');
  process.exit(1);
}

// Server client — bypasses RLS, full access. NEVER send to browser.
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/**
 * Verify a request's JWT, attach req.user with { id, email, is_admin }.
 * Front-end sends: Authorization: Bearer <jwt-from-supabase-session>
 */
async function requireAuth(req, res, next) {
  try {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'No auth token' });

    // Supabase verifies the JWT for us
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data?.user) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    // Look up profile to get is_admin flag
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('is_admin, display_name')
      .eq('user_id', data.user.id)
      .single();

    req.user = {
      id: data.user.id,
      email: data.user.email,
      is_admin: profile?.is_admin || false,
      display_name: profile?.display_name || data.user.email,
    };
    req.supabase_token = token;
    next();
  } catch (err) {
    console.error('requireAuth error:', err);
    res.status(500).json({ error: 'Auth check failed' });
  }
}

/** Block non-admins. Use AFTER requireAuth. */
function requireAdmin(req, res, next) {
  if (!req.user?.is_admin) return res.status(403).json({ error: 'Admin only' });
  next();
}

/**
 * Factory: returns middleware that blocks if user lacks active subscription
 * for the given sport. Use AFTER requireAuth.
 *
 *   app.get('/api/mlb/plays', requireAuth, requireSport('mlb'), handler);
 */
function requireSport(sportId) {
  return async (req, res, next) => {
    if (req.user.is_admin) return next();   // admins bypass
    const { data, error } = await supabaseAdmin
      .from('subscriptions')
      .select('status')
      .eq('user_id', req.user.id)
      .eq('sport_id', sportId)
      .eq('status', 'active')
      .maybeSingle();
    if (error) return res.status(500).json({ error: 'Subscription check failed' });
    if (!data) return res.status(402).json({ error: `No active ${sportId.toUpperCase()} subscription`, sport: sportId });
    next();
  };
}

module.exports = {
  supabaseAdmin,
  requireAuth,
  requireAdmin,
  requireSport,
};
