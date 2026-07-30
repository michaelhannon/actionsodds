# Action's Odds — Developer Hand-off Spec

**For:** Mike (engineering) · **From:** Kenny · **Date:** July 10, 2026
**Scope:** Rule changes locked in the 7/10 session + the validation/CLV infrastructure, written as buildable engine logic. Read top to bottom; §6 is the dependency that gates most of it.

---

## 0. The one blocker that gates everything

Allowlist **`api.the-odds-api.com`** in the network egress settings. The Odds API key is already wired into `loadOdds()`. Until this host is reachable, the value-scan (§3), the totals line-shop (§2), and the CLV logging (§4) can't run automatically — they degrade to slow manual work. This is the highest-leverage single change on the list.

---

## 1. Step 0 — date AND clock gate (card generation)

Current bug this fixes: cards have rendered the wrong day, and started games have appeared as bettable.

**Logic:**
1. On card build, resolve `now()` in ET from a verified source, not an assumed system date.
2. Pull the live slate; each game has a `first_pitch` timestamp.
3. **Filter: only render games where `first_pitch > now()`.** Any game already started or in progress is dropped from the card before display — never surfaced as bettable.
4. Log the current timestamp on the card header so it's auditable.

Acceptance: a card built at 7:10 PM ET shows zero games with first pitch ≤ 7:10 PM.

---

## 2. Totals engine — line-shop before juice

Core principle: **more winning tickets and positive CLV are not the same thing.** Laying −120/−125 to manufacture winners produces green checkmarks with negative CLV underneath — the record that fails an audit. Line-shopping is how you get more winners *without* laying juice.

**Logic for every total (F5 or full-game):**
1. Pull the exact total (e.g. Over 5) across all books: FanDuel, DraftKings, Caesars, BetMGM, Hard Rock, Fanatics.
2. Select the **best available price** for that side.
3. **Gate:** render as a play only if best-available is **≈ −115 or better.** If every book is −120 or worse → **PASS** (flag `juice_too_high`), unless a manual conviction override is set.
4. Record which book had the best number and the price taken (feeds CLV in §4).

Worked example: F5 Over 5 at −125 = 55.6% break-even. Same bet at −110 = 52.4%. Capturing that 10–15¢ is pure CLV and is the entire mechanism.

---

## 3. Value-scan pass on no-plays

Runs after the core card is scored. Purpose: catch mispriced sides on games the system passed — **without** turning every pass into a play.

**Logic:** for each game graded no-play, scan three columns:
- **ML dog** priced *longer* than arm / injury / park explains
- **Total** soft in the F5 or full-game window
- **Run line** value

**Critical rule:** flag a game ONLY when there is an *identifiable reason* the price is wrong. If the dog price is fully explained (bad starter, injury, park), it stays a pass. Most games return empty — that's correct behavior, not a failure. The passes are the product.

Output: a short "value flags" section under the main card, each flag tagged with its reason. No reason = no flag.

---

## 4. CLV logging — every play, forward only

The number that makes the track record auditable and sells subscriptions. Cannot be reconstructed retroactively — starts the day it ships.

**Per play:** log `entry_price`, `entry_time`, side, book taken. At first pitch, capture the `close_price` (last pre-game snapshot). Compute:
- `clv_cents` = entry vs close (sign-normalized: longer-than-close = positive)
- `clv_prob` = de-vigged fair-prob difference

**Rollups:** % of plays beating close (target > 53%), mean CLV per 100-play window, CLV-to-ROI correlation. If realized P&L is red but CLV is green → good process, bad variance, keep going. If CLV is red → the reads aren't beating the market, stop and fix regardless of W/L.

(Full schema + de-vig formulas in the separate Validation & CLV Spec.)

---

## 5. Guardrails to enforce in code (not optional)

- **No fabricated/stale prices.** If the feed can't confirm a live number, the play is flagged `unverified` and **held, not carded** — never filled from memory or a stale page.
- **No retroactive CLV.** Pre-ship plays are never presented as CLV-verified.
- **Sample gate on any marketed figure:** N ≥ 200 and the CI test in the Validation spec before a cohort or overall number is shown to a prospective client.
- **Separate ledgers:** core W-L (T1/T11/T12/T13) vs exotic/totals/parlay stay in different columns; never blended when measuring system edge.

---

## 6. Build order

1. Allowlist `api.the-odds-api.com` (§0) — unblocks everything below.
2. Step-0 date+clock filter on card generation (§1).
3. Odds snapshot capture into the DB (open / intraday / pre-game close).
4. Totals line-shop + juice gate (§2).
5. CLV logging + rollups (§4).
6. Value-scan pass (§3).
7. Calibration backtest (separate Validation & CLV Spec) once historical odds are loaded.

---

## 7. One-paragraph summary

The handicapping logic already works. What today's changes add is discipline the engine has to enforce so a human doesn't have to catch it: never show a started game, never lay juice you could have shopped away, never card a number you couldn't verify, and log every play against its close so the record proves itself. All four run automatically off one clean odds feed and painfully by hand without it — so the allowlist is step one. The end state is an app whose track record is auditable on CLV, not just a wall of green checkmarks.
