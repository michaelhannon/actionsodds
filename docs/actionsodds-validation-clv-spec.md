# Action's Odds — Validation & CLV Measurement Spec

**Prepared for:** Mike (engineering) · **Owner:** Kenny
**Purpose:** Turn the handicapping system from "internally rigorous" into "provably priced-beating." This is the measurement layer that has to exist *before* a verified track record is marketed to clients.
**Status of dependency:** Requires `api.the-odds-api.com` on the network egress allowlist and a historical-odds data source (see §7). Nothing below can produce real numbers until the odds pipe is open.

---

## 0. What we are actually proving

Two separate jobs, often confused, both required:

1. **Calibration backtest (retrospective).** Over the last 3 seasons, do the system's flagged plays — and specific cohorts like heavy-favorite dogs in July/August — win at rates that *beat their price*? This is the empirical answer to the "Dog Days edge vs. the −200 tax" question we've been reasoning about. Reasoning gets us a hypothesis; this gets us a number.

2. **CLV tracking (forward).** For every play we make from here on, did we beat the closing line? This is the definitive skill-vs-variance metric and the thing a sophisticated client will audit. It cannot be reconstructed retroactively — plays logged without captured closing lines are lost to it forever. **Start date = the day this ships.**

A play can lose and still be a good bet (positive CLV, unlucky). A play can win and still be a bad bet (negative CLV, lucky). We are grading process, not outcomes. That distinction is the whole point.

---

## 1. Core formulas (implement exactly)

**American odds → implied probability**
- Negative (−X): `impl = X / (X + 100)`
- Positive (+Y): `impl = 100 / (Y + 100)`

**Break-even win rate** for a price = its implied probability. (+220 → 31.25%; −200 → 66.7%; −267 → 72.7%.)

**De-vig (fair) probability**, two-way market with raw implieds `p_fav`, `p_dog`:
- `hold = p_fav + p_dog − 1`
- `fair_fav = p_fav / (p_fav + p_dog)`, `fair_dog = p_dog / (p_fav + p_dog)`

De-vigged fair probability is what we compare against *actual* win rate, because it strips the book's margin and isolates the true market estimate.

**CLV (closing line value)** for a bet on side S:
- `clv_prob = fair_prob_close(S) − fair_prob_entry(S)`
  - Positive → we got a better price than the market's final estimate (good).
- Also store raw cents: `clv_cents = american_entry(S) − american_close(S)` (sign-normalized so "longer price than close" = positive).

**Flat-stake ROI over a cohort:**
- `ROI = (Σ payout_on_wins − Σ stake_on_losses) / Σ stake`
- Use 1 unit flat for backtest cohorts (real sizing is separate and does not belong in an edge test).

---

## 2. Data model (Supabase)

### `games`
| field | type | source |
|---|---|---|
| game_pk | int PK | statsapi.mlb.com (gamePk) |
| date | date | statsapi |
| season | int | statsapi |
| home_team / away_team | text | statsapi |
| home_sp / away_sp | text | statsapi probables |
| sp_confirmed | bool | statsapi (scratch detection) |
| final_home / final_away | int | statsapi (nightly settle) |
| margin | int | derived |
| total_runs | int | derived |

### `odds_snapshots`
| field | type | notes |
|---|---|---|
| game_pk | int FK | |
| captured_at | timestamptz | snapshot time |
| book | text | draftkings / fanduel / betmgm / caesars |
| ml_home / ml_away | int | American |
| rl_home_line / rl_home_price | num/int | run line |
| rl_away_line / rl_away_price | num/int | |
| total_line / over_price / under_price | num/int | |
| snapshot_type | enum | `open` / `intraday` / `close` |

`close` = last snapshot strictly before first pitch. This is the single most important row in the system — protect it.

### `plays`
| field | type | notes |
|---|---|---|
| play_id | uuid PK | |
| game_pk | int FK | |
| side | text | team + market (ML / RL / total) |
| entry_price | int | American, at time we bet |
| entry_at | timestamptz | |
| triggers_fired | jsonb | `["T13","DogDays","T6-Δ"]` — cohort slicing |
| stake_units | num | real sizing |
| structure | enum | straight / parlay / rr / rl-addon |
| result | enum | win / loss / push / void (nightly settle) |
| realized_pl | num | settled dollars |
| close_price | int | pulled at settle |
| clv_prob / clv_cents | num/int | computed at settle |

---

## 3. Calibration backtest — design

**Cohorts to grade** (each split by month, isolating **July** and **August** as their own buckets):

- Heavy-favorite dogs by price band: `+180/+219`, `+220/+259`, `+260/+299`, `+300+`
- The corresponding favorites by band: `−180/−219` … `−300+`
- **System-flagged plays** (any play where the gate passed and ≥1 trigger fired), so we grade *our* selections, not just the market.
- Home dogs vs. road dogs, separately (they behave differently on the run line — home favs cover −1.5 ~39%, road favs ~44%).

**For each cohort, compute:**
- N (sample size)
- Actual win % (SU) and actual cover % (run line)
- Mean de-vigged fair prob (what the market expected)
- **Gap = actual − expected**
- Flat-stake ROI at the cohort's real prices

**Pass / fail rule (this is where honesty lives):**
A cohort is a *real* edge only if **all three** hold:
1. Flat-stake ROI > 0, **and**
2. The 95% binomial confidence interval on win rate has its **lower bound above break-even** (not just the point estimate — this kills small-sample mirages), **and**
3. N ≥ 200 for the cohort.

If N < 200 (likely for single-month 3-year cuts), the result is **"insufficient sample — do not market,"** not "edge." Say so explicitly in the output. A 34%-vs-31% gap on 60 games is noise; the CI will show it.

**The specific question this answers:** are July/August dogs at +220+ hitting above ~31%, with the CI to back it? If yes → quantified, defensible Dog Days edge. If no → we're paying the −200 tax and the rule gets retired. Either result is worth money.

---

## 4. CLV tracking — forward, every play

At **entry**: log side, `entry_price`, `entry_at`.
At **first pitch**: capture `close_price` (last pre-game snapshot).
At **settle** (nightly): compute `clv_prob`, `clv_cents`, `result`, `realized_pl`.

**North-star metrics (rolling, per 100-play window):**
- % of plays with positive CLV — **target > 53%**
- Mean CLV (prob terms) — **target > 0, trending up**
- Correlation of CLV to realized ROI — should be positive; if realized ROI is red but CLV is green, we're good bettors running bad, keep going. If CLV is red, the reads aren't beating the market — stop and fix, regardless of W/L.

CLV is the number that goes in front of a client. A few hundred plays of positive average CLV = demonstrated edge that survives an audit. Nothing else does.

---

## 5. Settlement pipeline (nightly job)

1. Pull finals + box from `statsapi.mlb.com` for all `games` where date = yesterday.
2. Grade every `play`: win / loss / push / void.
3. Compute `realized_pl` from `entry_price` × `stake_units`.
4. Pull the `close` snapshot; compute CLV fields.
5. Update running ledger (realized P&L) and CLV rollups.
6. Emit a daily settle report: yesterday's plays, results, CLV per play, ledger delta, rolling CLV window.

---

## 6. Guardrails (baked into the code, not optional)

- **No retroactive CLV.** If we didn't capture the close, the play has no CLV — never back-fill an estimate and never present a pre-ship record as CLV-verified.
- **Stale-data halt.** If the odds snapshot for a game is older than a set threshold at entry time, flag the play `unverified_price` and exclude it from CLV aggregates.
- **Sample gate on marketing.** No cohort or overall figure is shown to a prospective client until N ≥ 200 and the CI rule in §3 passes. This is a hard gate, same spirit as the pre-filter gate on the card.
- **Separate edge from sizing.** Backtests are flat-stake. Sizing (unit ladder, bell curve, caps) is a bankroll question layered on *after* an edge is proven, never mixed into the proof.

---

## 7. Build sequence & blocking dependencies

1. **Allowlist `api.the-odds-api.com`** in network egress settings. Nothing works without live odds. (Live endpoint: `/v4/sports/baseball_mlb/odds`.)
2. **Historical odds source** for the backtest — The Odds API historical snapshots (`/v4/historical/sports/baseball_mlb/odds`, paid tier) or an equivalent 3-season open+close dataset. This is the single hardest data get; without captured historical *closing* lines the calibration study can't run. Scope/price this first.
3. **statsapi integration** — schedule, probables, finals, standings w/ streakCode + run differential. Clean JSON, no scraping. This becomes the permanent data spine and retires the ESPN/Covers screen-scraping entirely.
4. **Supabase schema** per §2.
5. **Snapshot capture job** — pull odds every N minutes into `odds_snapshots`, tag the pre-game `close`.
6. **Nightly settlement job** per §5.
7. **Calibration backtest** per §3 once historical odds are loaded.
8. **CLV dashboard** — rolling windows, per §4.

---

## 8. One-paragraph summary for the punch list

The system's reads are the easy part and they're already built. What's missing is proof they beat the price. This spec builds two things off one odds feed: a retrospective calibration study that settles the Dog Days / heavy-favorite question with real numbers and confidence intervals, and a forward CLV tracker that logs every play against its closing line so the track record builds itself honestly from day one. Both are blocked on the same thing — a real odds API, allowlisted, plus a historical closing-line dataset. Open that pipe and everything downstream is standard Node/Supabase work. This is the piece that turns good handicapping into a business a client can audit.
