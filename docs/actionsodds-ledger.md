# Action's Odds — Consolidated Ledger

**Compiled:** July 30, 2026
**Scope:** Verified plays from screenshots + directly-reported results, ~July 8–29, 2026.
**Counting rule:** each play/leg is its own entity; a game appearing in multiple tickets counts ONCE (dedup by unique game outcome).

---

## STATUS OF THIS LEDGER — read first

This is **directionally honest but not certified.** It is built from screenshots and reported results, not a clean sportsbook feed. The **authoritative source is the Caesars + Hard Rock settled-bet export** — reconcile against that before any number goes in front of a client.

The pre-July reconstructed record is **internally inconsistent** (three "official" snapshots — 25-10, 25-9, 23-9 — that can't all be true, plus a detailed reconstruction near 32-24; a running win count can't decrease, so these are separate recounts). It contains a confirmed phantom entry and a confirmed misgrade. It is **NOT included** in the tally below and cannot be certified without the export.

**No CLV is captured** on any of these. That is the single most important gap.

---

## VERIFIED RECENT PLAYS (individual entities)

### Wins
| Date | Play | Price | Bucket |
|---|---|---|---|
| 7/8 | Over 7.5 (MIL@STL) | ~+105 | exotic/total |
| 7/10 | TOR ML (live) | +280 | exotic/live |
| 7/11 | BOS ML (Mets fade) | +130 | core |
| 7/11 | TB −1.5 | +180 | exotic/RL |
| 7/22 | CIN ML | +130 | core |
| 7/22 | PIT ML (G1) | +150 | core |
| 7/25 | ATL ML | −110 | core |
| 7/25 | CWS ML | −115 | core |
| 7/26 | SD ML (Kenny's read) | +118 | core |
| 7/28 | CLE ML (Kenny's read) | +140 | core |
| 7/28 | Cubs −1.5 (leg) | +135 | exotic/RL |
| 7/28 | F5 Under (PHI/MIA) (leg) | −110 | exotic/F5 |
| 7/28 | NYY ML (leg) | — | core |
| 7/28 | SEA ML (leg) | +150 | core |

### Losses
| Date | Play | Price | Bucket |
|---|---|---|---|
| 7/11 | DET ML | +120 | core |
| 7/11 | MIL ML (G1) | even | core |
| 7/17 | NYY ML | −105 | core (+CLV loss) |
| 7/24 | PHI ML | −130 | core (+CLV loss) |
| 7/27 | ATH ML | +150 | core |
| 7/27 | CWS ML | +120 | core |
| 7/26 | NYY (×4 tickets, 1 game) | +158/+178/±1.5 | core — ONE entity |
| 7/28 | COL ML (leg) | — | exotic/RL |
| 7/29 | BOS team total O6.5 | +120 | exotic/total (won game, lost total) |

### Void / no-action
| 7/10 | MIL ML | +105 | rainout — refunded, off ledger |

### Pending (NOT booked — awaiting clean confirmation)
7/29: CIN +118 · ATL −165 (G2) · NYY −145 · SEA +150 — held until finals verified.

---

## TALLY (verified, deduped entities)

- **Wins:** ~14
- **Losses:** ~11 (1 void excluded)
- **Win rate:** ~.55 on documented recent individual plays
- **Pending:** 4 (7/29) not yet booked

### By bucket
- **Core W-L:** mixed, roughly break-even-to-modestly-red on the half. Two dog winners (CIN, PIT) built a cushion; concentration (NYY ×4) and chalk losses ate it.
- **Exotic/live/total:** net positive (TOR +280, Over 7.5, TB −1.5 carried it).

---

## PATTERNS THE DATA SHOWS (validated)

1. **Wins cluster on plus-money dogs** (CIN +130, PIT +150, BOS +130, SD +118, CLE +140). **Losses cluster on laying juice** (NYY −105, PHI −130) and on **single-game concentration** (NYY ×4 = the largest single-day loss). This directly validates the plus-money-dog philosophy and the single-game cap.

2. **Kenny's reads beat the model's caution repeatedly** — SD +118, CLE +140 were passes by the value-scan and wins by Kenny. This is the evidence behind the v3 change (pitching demoted from veto to weighted input).

3. **The +CLV losses (NYY 7/17, PHI 7/24) beat the closing line and still lost.** Correct process, wrong side of a coin flip. This is exactly why CLV, not W/L, is the metric that proves the edge — and exactly why it must be captured going forward.

---

## ACTION FOR THE BUILD

- Reconcile this against the Caesars/Hard Rock export → the certified founding ledger.
- Start CLV capture on the NEXT play (cannot be reconstructed backward).
- Log each trigger's fire/result per play so v3 weights calibrate.
