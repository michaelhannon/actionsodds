# Action's Odds — System Specification v3.0

**Updated:** July 30, 2026 · **Supersedes:** V2.0 reference
**Owner:** Kenny (strategy) · **Build:** Mike (engineering)
**Core philosophy:** Plus-money dogs are the structural edge. Chalk and juice are the leak. Selectivity is an advantage — but *sizing*, not a binary in/out, is how selectivity is expressed.

---

## WHAT CHANGED IN v3 (locked 7/30/2026)

Three amendments, driven by results — the reconstructed record and the last three weeks both showed the same thing:

1. **Pitching (T6) is demoted from a veto to one weighted input.** Prior behavior treated a bad/good starter as a kill-switch — "the opposing arm is an ace, so pass." That is NOT the system. T6 is *one trigger* in a cumulative grid; it contributes weight, it does not gate. Evidence: multiple "explained-dog" passes (Cleveland, the Reds) won when played. Over-weighting the arm was costing plays that fit the rest of the grid.

2. **The cumulative trigger score sets the WAGER SIZE, not the play/pass decision.** A marginal score is a *smaller* play (½u), not a no-play. We only truly pass when the grid is empty or internally contradictory. This produces more plays without lowering standards, because confidence is carried by size, not by a binary gate.

3. **Every trigger is logged as its own entity, with its own weight, calibrated by results.** Weights are earned by the data (does this trigger beat the closing line?), not frozen by feel. This is the feedback loop that keeps the added volume profitable.

**Why this matters for the business:** a subscription product for non-whale clients needs *volume* — multiple profitable plays, consistently. One or two plays a month serves only large-stakes bettors. v3 scales volume through sizing and multi-market coverage while the calibration loop keeps the volume +EV.

---

## SESSION PROTOCOL (run in order, every session)

**STEP 0 — Date + clock gate (MANDATORY).** Confirm current date AND clock time (ET), verified against the live slate. Then, before showing any card, DROP every game whose first pitch is already past the current timestamp. Never present a started game as bettable. This is the system's job, never the user's.

**STEP 1 — Pre-filter.** Pull all 30 teams: streaks, run differentials, splits. PLAY-side = positive RD + W1+. FADE-side = negative RD + L1+. Cross-reference the slate; perfect collisions (play vs fade, same game) = top priority. *In v3 the pre-filter narrows focus but does not hard-gate — a strong cumulative score elsewhere can still produce a sized play.*

**STEP 2 — Full weighted trigger grid.** Score every candidate against the complete trigger set as a visible grid, each trigger marked fire/no-fire/direction with its weight. Walk every row, not just the salient ones.

**STEP 3 — Cumulative score → SIZE → price.** The summed weighted score sets play/pass AND size. Pricing and structure (straight/parlay/RR) come last, scraped live, best number locked.

---

## THE TRIGGER SET (each an entity, each weighted)

| Trigger | What it measures | Role in v3 |
|---|---|---|
| T2 Streak | current W/L streak | pre-filter + bell-curve sizing |
| T3 Run differential | season RD, sign + pace | weighted; sign informs gate |
| **T6 SP quality** | starter ERA/FIP/xERA | **weighted input — NOT a veto** |
| T6-Δ | FIP/xERA vs ERA gap | +weight when surface stat misleads (both directions) |
| T8 Bullpen (48hr) | pitches thrown / fatigue | weighted; closer IL boosts |
| T-REG | home/road split regression | weighted; DIRECTION check mandatory (low split = BUY) |
| T-INJ | key injuries | weighted; market lags 24–48hr |
| T-FAT | fatigue / compressed schedule | weighted; road 9-in-10 etc. |
| T-CF | catcher framing (+ABS) | +0.5 weight only |
| T16 BvP | batter-vs-pitcher (min 10 AB) | mandatory pull on collisions |
| T14 Power | power-rating gap | weighted; large gap lowers size, doesn't auto-kill |
| Price band | ML price vs profile | sets which gate (T1/T11/T12/T13) + is itself the value test |

**Value-scan (the heart of it):** for every dog, ask — *is the price LONGER than the matchup explains, or is it explained?* A longer-than-explained price is the edge. An explained price (bad arm, cold team, park) is fair, not value. **In v3 this informs SIZE:** clean mispriced dog = full unit; partially-explained but live = ½u; fully-explained = pass. The old behavior (fully-explained = automatic pass, everything else full size) is replaced by this gradient.

---

## SIZING (universal)

- 1u = $200 (per current direction). Bell-curve streak sizing applies on top.
- **v3 rule: cumulative trigger score sets the unit fraction.** Marginal score → ½u. Strong score → 1u. Peak collision → up to bell-curve max.
- **Single-game exposure cap:** total dollars on any one team/game across ALL tickets (straight + parlay legs) is capped at ~2u equivalent. This is the one hard rule that survives everything — it is about exposure math, not handicapping, and it is the documented source of the largest losses (NYY concentration).
- Bell curve: W1/L1=1u → W5/L5 peak=3u → W11=EXIT. Perfect collision +0.5u (3u cap).

---

## MARKETS TO SCAN (v3 volume expansion)

Volume comes from covering more markets per game, NOT from forcing more sides. Each game is scanned across:
- Full-game moneyline
- Run line (±1.5) — situational only; historically our worst type, play only with a justified favorite/cold-opponent + plus price
- Full-game total (line-shop, play only at ~−115 or better)
- **First-5 (F5) moneyline & total**
- **First-3 (F3) moneyline & total**

Most markets in most games still return PASS. More markets = more *chances* to find the few mispricings, not a mandate to play one per game.

**INNING-PROP DATA EXCEPTION (locked 7/30):** F3/F5 lines do not render on scrapeable pages (JS-only, behind login). For inning props ONLY, asking Kenny for the number is acceptable — and only after the full-game sweep is done. Everything else (full-game lines, standard totals) the system pulls itself.

---

## STANDING TEAM RULES (re-confirm each game)

- **NYM:** standing fade. Express by backing the opponent at a fair-or-plus price, not by laying heavy chalk on the opponent. Fade strongest when Soto sits / NYM on W2–3.
- **NYY:** parlay-leg-only, never straight, while Judge is out. (Note: results have repeatedly shown the market NOT overpricing them — treat the leg-only rule as an exposure guard, and let the grid, not a blanket fade, decide direction.)
- **Hot group (MIL / LAD / MIA):** route to legs, not straight chalk.
- **Cold list:** refresh periodically.

---

## ODDS & CLV PROTOCOL

- Line-shop across 5–6 books (FanDuel, DraftKings, Caesars, BetMGM, Hard Rock, Fanatics); take the best number.
- **Never lay −120+ on a total by default** — shop first, play only at ~−115 or better.
- Track CLV (entry price vs closing line) on EVERY play. Entry price + timestamp captured at bet time; closing line captured at first pitch.
- **Night-before / early-morning entry is the primary CLV engine** — soft openers, before the steam. Morning entries still capture CLV against the evening close. (Night-before-by-hand is constrained by the user's schedule; the automated app is the real night-shift solution.)
- Unverified number after full sweep = flagged UNVERIFIED, play HELD not carded — never fabricated.

---

## THE MEASUREMENT LAYER (why this exists)

The reads are mid-50s and the philosophy is data-validated (wins cluster on plus-money dogs, losses on chalk/run-lines). But **no CLV is captured yet**, so the edge is unproven against the close. Everything above is only sellable once:
1. `api.the-odds-api.com` is allowlisted (clean lines + probables in one pull — unblocks automation)
2. Every play logs entry vs closing line (CLV)
3. Each trigger's fire/result is logged so weights calibrate to what actually beats the close
4. A 200+ play sample accumulates

That sample is what tells us whether the v3 weighted-volume model beats the market — and it's the auditable track record that sells subscriptions. Green checkmarks without CLV underneath are a house of cards.

---

## PENDING / OPEN

- Allowlist the odds API (gates automation + CLV + calibration)
- Build the weighted-trigger calibration engine (this spec's core)
- Reconcile the authoritative ledger from Caesars/Hard Rock settled-bet exports
- Soccer trigger grid (open item)
- NFL v1.6 for Week 1 prep
