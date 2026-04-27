/**
 * Action's Odds — Server-side AI brief generator
 *
 * After the morning scan publishes new plays to actions_plays, this module
 * generates a 2-sentence brief for each one and stores it in the
 * actions_plays.brief column. Briefs are cached forever — they reflect the
 * scan state at the moment the play was qualified, and shouldn't change.
 *
 * Idempotency:
 *   - Only generates briefs for plays where `brief IS NULL`.
 *   - Safe to call multiple times — re-runs skip already-briefed plays.
 *
 * Cost shape:
 *   - One Claude Sonnet 4.6 call per qualifying play, ~600 tok in / 200 tok out
 *   - At 3-7 plays/day that's ~$0.05-0.10/day total, regardless of traffic
 *
 * Failure handling:
 *   - If Claude API fails or returns garbage, brief stays NULL — front-end
 *     falls back to "brief pending" placeholder. Next scan or manual trigger
 *     will retry.
 *   - If ANTHROPIC_API_KEY missing, module logs and exits cleanly.
 */

const https = require('https');
const { supabaseAdmin } = require('./auth');

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 300;

/**
 * Make one Anthropic API call. Returns the text content or null on failure.
 */
function anthropicCall(prompt) {
  return new Promise((resolve) => {
    if (!ANTHROPIC_KEY) {
      console.warn('[Briefer] ANTHROPIC_API_KEY not set — skipping');
      return resolve(null);
    }
    const body = JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages: [{ role: 'user', content: prompt }],
    });
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': ANTHROPIC_KEY,
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          console.error(`[Briefer] Anthropic ${res.statusCode}: ${data.slice(0, 400)}`);
          return resolve(null);
        }
        try {
          const parsed = JSON.parse(data);
          const text = parsed?.content?.[0]?.text;
          resolve(text || null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', (err) => {
      console.error('[Briefer] Network error:', err.message);
      resolve(null);
    });
    req.setTimeout(30000, () => {
      req.destroy(new Error('Anthropic timeout'));
    });
    req.write(body);
    req.end();
  });
}

/**
 * Build a prompt from a scan play. Pulls live context from the scan —
 * streaks, run diffs, triggers — so the brief is grounded in actual data.
 */
function buildPrompt(scanPlay) {
  const a = scanPlay.analysis || {};
  const sideTeam = a.gateSide === 'home' ? scanPlay.home?.name : scanPlay.away?.name;
  const oddsStr = a.gateML > 0 ? `+${a.gateML}` : `${a.gateML}`;
  const triggers = (a.triggered || []).map((t) => t.code || t.name || t).filter(Boolean);
  const stake = Math.round((a.units || 0) * 100);
  const homeStreak = `${scanPlay.home?.streak || ''}${scanPlay.home?.streakLen || 0}`;
  const awayStreak = `${scanPlay.away?.streak || ''}${scanPlay.away?.streakLen || 0}`;
  const homeRD = scanPlay.home?.runDiff != null
    ? (scanPlay.home.runDiff >= 0 ? '+' : '') + scanPlay.home.runDiff : 'n/a';
  const awayRD = scanPlay.away?.runDiff != null
    ? (scanPlay.away.runDiff >= 0 ? '+' : '') + scanPlay.away.runDiff : 'n/a';

  return `You are the Action's Odds MLB system AI. Grade this qualifying play in 2 sentences.

GAME: ${scanPlay.away?.name} (${awayStreak}, RD ${awayRD}) @ ${scanPlay.home?.name} (${homeStreak}, RD ${homeRD})
PICK: ${sideTeam} ML ${oddsStr}  |  GATE: ${a.gateType}  |  STRENGTH: ${a.strength} (${a.units}u, ~$${stake} at $10K ref)
TRIGGERS FIRED: ${triggers.join(', ') || '—'}
NOTES: ${(a.notes || []).join(' | ') || '—'}

System rules: T1=home dog +140-+199, T11=cheap home fav -115/-135 (3+ trig), T12=home dog +110-+134 (4+ trig), T13=road dog +120+ (5 required), T14=power ratings mandatory.

Give one sentence on the strongest signal, one on the recommendation. Be terse. No fluff. Work only from what's above.`;
}

/**
 * Generate briefs for any plays in actions_plays that don't have one yet.
 * Optionally pass a scan object to source rich context (streaks, triggers).
 * If no scan is passed, generates briefs from the row data alone (fallback).
 *
 * Returns { generated, skipped, errors }
 */
async function generateMissingBriefs(scan = null) {
  if (!ANTHROPIC_KEY) {
    return { generated: 0, skipped: 0, errors: ['ANTHROPIC_API_KEY missing'] };
  }

  // Fetch plays needing briefs (today + last 2 days, MLB only for now)
  const { data: plays, error } = await supabaseAdmin
    .from('actions_plays')
    .select('*')
    .eq('sport_id', 'mlb')
    .is('brief', null)
    .neq('bet_type', 'BACKFILL')   // skip the seed row
    .order('play_date', { ascending: false })
    .limit(20);

  if (error) {
    console.error('[Briefer] Fetch failed:', error.message);
    return { generated: 0, skipped: 0, errors: [error.message] };
  }
  if (!plays || plays.length === 0) {
    return { generated: 0, skipped: 0, errors: [] };
  }

  // If we have a scan, build a lookup by game string for rich context
  const scanByGame = {};
  if (scan && Array.isArray(scan.plays)) {
    for (const p of scan.plays) {
      if (p.game) scanByGame[p.game] = p;
    }
  }

  let generated = 0, skipped = 0;
  const errors = [];

  for (const play of plays) {
    let prompt;
    const scanPlay = scanByGame[play.game];
    if (scanPlay) {
      prompt = buildPrompt(scanPlay);
    } else {
      // Fallback: build from the actions_plays row alone
      prompt = `You are the Action's Odds MLB system AI. Grade this qualifying play in 2 sentences.

GAME: ${play.game}
PICK: ${play.selection}  |  STAKE: $${play.stake}  |  ODDS: ${play.odds > 0 ? '+' : ''}${play.odds}
NOTES: ${play.notes || '—'}

Give one sentence on the strongest signal, one on the recommendation. Be terse. No fluff.`;
    }

    const text = await anthropicCall(prompt);
    if (!text) {
      skipped++;
      errors.push(`${play.game}: no text returned`);
      continue;
    }

    const { error: updErr } = await supabaseAdmin
      .from('actions_plays')
      .update({
        brief: text,
        brief_generated_at: new Date().toISOString(),
      })
      .eq('id', play.id);

    if (updErr) {
      errors.push(`${play.game}: ${updErr.message}`);
      skipped++;
    } else {
      generated++;
      console.log(`[Briefer] ${play.play_date} ${play.selection} → brief ✓ (${text.length} chars)`);
    }
  }

  console.log(`[Briefer] Done — ${generated} generated, ${skipped} skipped`);
  return { generated, skipped, errors };
}

/**
 * Force-regenerate briefs for a set of play IDs (admin manual trigger).
 * Overwrites existing briefs.
 */
async function regenerateBriefs(playIds = []) {
  if (!ANTHROPIC_KEY) return { regenerated: 0, errors: ['ANTHROPIC_API_KEY missing'] };
  if (!Array.isArray(playIds) || playIds.length === 0) return { regenerated: 0, errors: [] };

  const { data: plays, error } = await supabaseAdmin
    .from('actions_plays')
    .select('*')
    .in('id', playIds);

  if (error) return { regenerated: 0, errors: [error.message] };

  let regenerated = 0;
  const errors = [];

  for (const play of plays || []) {
    const prompt = `You are the Action's Odds MLB system AI. Grade this qualifying play in 2 sentences.

GAME: ${play.game}
PICK: ${play.selection}  |  STAKE: $${play.stake}  |  ODDS: ${play.odds > 0 ? '+' : ''}${play.odds}
NOTES: ${play.notes || '—'}

Give one sentence on the strongest signal, one on the recommendation. Be terse. No fluff.`;

    const text = await anthropicCall(prompt);
    if (!text) {
      errors.push(`${play.id}: no text`);
      continue;
    }
    const { error: updErr } = await supabaseAdmin
      .from('actions_plays')
      .update({ brief: text, brief_generated_at: new Date().toISOString() })
      .eq('id', play.id);
    if (updErr) errors.push(`${play.id}: ${updErr.message}`);
    else regenerated++;
  }

  return { regenerated, errors };
}

module.exports = { generateMissingBriefs, regenerateBriefs };
