# Quant testing plan — how to find out whether the signals have edge

Date: 2026-07-09. Scope: the P1–P3 signals (all shipped flag-OFF) and the
pipeline as a whole.

## The one rule

**The cardinal sin is manufacturing false confidence.** So the whole plan is
built on one asymmetry:

> **The backtest is licensed only to DISPROVE a signal. Acceptance is only ever
> earned on the live paper soak.**

Why the backtest can't accept: the window is ~124 trading days ≈ **one regime
observation**, ~7–13 historical trades (below `min_trades_for_economic_claim`
= 50, so the report already refuses a PASS/FAIL); the analyst LLMs may have
*trained* on the 2026 window (outcome memorization that **no code probe can
detect**); and the fill model (`src/backtest/fills.ts`: strict limit-cross, no
partials, 20× volume guard) is **optimistic exactly where the fill-quality
signals operate**. Config already records "no positive edge at any threshold" —
treat that as the prior.

"Undecided" is the default. Most of the 19 signals will stay flag-off because
the data can't support accepting them. **That is the plan working, not failing.**

## The missing primitive

The system logs the *chosen* order, never the counterfactual — so a signal's
marginal effect on live trades isn't attributable yet. Everything hinges on
building a **same-decision paired counterfactual**: on each sizing/gate decision,
record the outcome WITH and WITHOUT signal X on the *same* thesis, quotes, and
fill. This defeats two confounds at once:

- **Beta-timing** — a down-only scalar that merely cut gross in a down market
  looks like alpha. (Same decision, same market → controlled.)
- **LLM nondeterminism** — a naive wall-clock A/B (signals-on run vs signals-off
  run) diverges on model drift, not signal. (Same thesis, no second run.)

## Stages (run in order)

### Stage 0 — Validity probes (before building anything)
Cheapest possible kill. Run `scripts/backtest-probe.ts` (`cutoffIntrudes`, the
masked-vs-unmasked verdict probe `maskNumerics`/`pairTrips`/`wilson95`) and audit
`src/backtest/scans.ts` for point-in-time/survivorship (as-of bars, no
forward-fill).
**Decide:** if leakage fires or the masked probe fails at power → STOP; no
backtest verdict is admissible, only the live soak is valid OOS. Record the
LLM-training-cutoff-vs-window contamination as a standing caveat (undetectable by
any probe).

**Status (run 2026-07-10): the STOP branch is taken.** The positive controls
failed to trip on two personas (sentiment divergence ≤ 0.05, fundamental 0.1;
trip threshold 0.3) → the probe is **powerless** and arms 1–2 were skipped as
uninterpretable. Cutoff verification: published training-data cutoff for
claude-sonnet-5 and claude-opus-4-8 is **Jan 2026** → intrudes on the window;
per the pre-registered rule any future headline must be the strictly
post-cutoff sub-window (Feb 1 – Jul 1), with January labeled
leakage-contaminated. Consequence: **no backtest verdict is admissible; the
paper soak is the only valid OOS instrument.** Artifacts:
`backtest-out/probe/{cutoff-note,controls,controls-fundamental}.json`; details
in the REPORT.md Revision 3 addendum.

### Stage 1 — Build the counterfactual instrumentation
The engineering that makes honest testing possible:
1. **Signal-toggle backtest cells** — extend `cellConfig` in `scripts/backtest.ts`
   (currently threshold×bearWeight) with one on/off cell per `signals.*`,
   `regime.*`, `portfolio.*`, `execution.*`, `calibration` flag, re-run under the
   deterministic `exact` LLM cache (`llm-cache.ts`) so on/off share byte-identical
   LLM inputs.
2. **Leave-one-out attribution** — `signalAttribution()` beside `attribution()`
   in `metrics.ts`; add applied-scalar + leave-one-out-qty to `EpisodeTrade`.
   **Marginal = realized − counterfactual, recomputing `combineScalars` on the
   reduced set. Never divide a scalar out** — `signal_scalar_floor` makes the
   product non-additive, so a floor-bound signal would read a false 0.
3. **Tier-2 live counterfactual audit** — a new `counterfactual` AuditEvent kind
   (`types.ts`/`audit.ts`) emitted at the sizing/gate points in `synthesis.ts` and
   `executor-loop.ts`, logging ON-size, leave-one-out OFF-size, and each gate's
   would-be-removed order. **Label it MODELED** (size-invariance is false for
   amihud/cost_scalar/participation).
4. **Regime label per episode** — stamp `computeRegime().state` onto
   `EpisodeResult`; add a per-regime economics slice to the report.
5. **Walk-forward** subcommand (sequential K-fold, K≤3) — overfit guard,
   mandatory for the fitted `calibration.table`.
6. **Typed trial registry + preflight gate** — `docs/TRIAL-REGISTRY.md` → typed
   rows; `preflight.ts` refuses to start if any enabled alpha flag lacks a
   pre-registered row; `renderReport` reads `nTrials` from the alpha-row count.
   Turns pre-registration from discipline into a build-time gate.

### Stage 2 — Backtest disprove funnel
For each toggle cell, diff `episodeNetUsd` across the on/off pair per episode,
report the paired-difference series with `bootstrapCi`. **Use the full re-run as
the decision metric, never per-trade add-back** — only the re-run captures
anti-chase band-tightening, the volume guard, and the budget cascade (a gate
freeing `deployedTodayUsd` shifts which later names clear the caps). Quote the
`designWeightedEstimate`, **never the H-stratum** (high-dispersion days flatter
trend/gap/dispersion). Slice per regime state.

**Validity preconditions (a comparison violating either is void, not a KILL):**
(1) on/off cells must cover the **identical episode-day set** — totals over
mismatched day sets are missing-episode artifacts, not signal effects; (2) the
signal must have **actually fired**: count episodes with a nonzero paired diff
(`nActive`). A cell where the toggle never changed any decision is **INERT —
not tested**, and must be reported as such, never as a KILL or a "no adverse
effect".

**Power limit (stated so a KILL is not oversold):** at the current sample
(~50 episodes, single-digit trades per cell), the paired-diff CI straddles 0
with probability ≈ 1 *regardless of the signal's true effect*. A Stage-2 KILL
therefore means "no evidence of edge at this n" — it licenses keeping the flag
off, not a claim that the signal is harmful or worthless. Only `nActive ≥ 10`
nonzero paired diffs makes a CI verdict worth recording; below that, record
INSUFFICIENT-N.
**Decide — KILL:** `nActive ≥ 10` and CI straddles 0, or favorable only in H,
or only in one regime. **SURVIVE (→ soak candidate, not accept):** CI excludes
0 on the design-weighted series.

### Stage 3 — Variance-sizing guardrails (backtest evidence admissible)
`portfolio.target_vol`/`inverse_vol`/`cov`, `regime.vol`/`gross`. Their metric is
realized **book vol / max-drawdown**, driven by real price paths, **not** the
optimistic fill model — so backtest evidence counts (still confirmed live).
Score each against a **placebo: a uniform gross haircut of equal average
magnitude**, on Sharpe.

**Placebo, defined (so it cannot be improvised at read time):**
1. **Magnitude** `c` = (total entry gross notional in the signal-ON re-run) ÷
   (total entry gross notional in the baseline re-run), computed over the full
   evaluation window from the same paired cells. `c` is estimated from the
   signal arm — it is a *matched* control, not an independent one; write `c`
   down (registry note) **before** scoring the placebo cell.
2. **Application:** a third full re-run cell whose only config change is a
   constant multiplier `c` on every entry's target notional, applied at the
   same sizing step the signal scales, on **every** decision (not just
   signal-active ones), through the same caps/floor/budget cascade.
3. **Metric:** Sharpe of the per-episode net-P&L series (plus the Stage-3
   book-vol / max-drawdown criteria), stratum handling identical to Stage 2
   (design-weighted; never H alone).
4. **Comparison:** the signal must beat the placebo cell on Sharpe at equal
   average gross. Equal Sharpe = the signal is exposure reduction, not skill —
   KILL.
**Decide — KEEP-candidate:** cuts book vol/drawdown ≥10–15% for a return give-up
whose CI isn't materially negative, AND beats the placebo. **KILL:** shaves
return without shrinking drawdown, or fails to beat the placebo (it was just
exposure reduction, not skill).

### Stage 4 — Fill-quality guardrails (screen only; needs real fills)
`cost_scalar`, `participation`, `entry_aggressiveness`, `gates_by_session`,
`amihud`. Backtest-toggle on `backtest-data/daily-sip/*` to disprove cheaply, then
apply a **fill-pessimism stress** (add slippage, count would-be-partials as
misses). **No accept from this stage** — mark all "requires real Alpaca fills."
IEX mismeasures the very spread/ADV these gate on.

### Stage 5 — Paired-counterfactual paper soak (the ONLY accept path)
Enable exactly one signal (pre-registered). For **scalars**: both branches take
the same trade differing only in shares → marginal P&L = Δshares × realized fill,
from the Tier-2 record. For **gates**: run the gate OFF, shadow-flag the
would-be-vetoes, track them to real exit → measure **realized** net P&L, never
imputed from the optimistic model.
**Decide — ACCEPT only if ALL hold:** (1) **≥50 OOS closed trades in which the
signal was ACTIVE** (non-unit scalar / gate-eligible) — not 50 total; read
nothing below 30 (`ATTRIBUTION_MIN_N`); (2) paired-difference bootstrap CI
excludes 0 favorably; (3) beats the placebo on Sharpe; (4) Stage-0 probes passed;
(5) fill-quality signals graded on real fills + the pessimism stress. **KILL a
gate** on a one-sided Wilson interval once its shadow-flagged vetoes are
net-positive (it's destroying edge).

### Stage 6 — Statistical gate
`deflatedSharpe` (`metrics.ts`) **> 0.95** with `nTrials` = count of `alpha` rows
in the typed registry (guardrail rows excluded). Log the **full-stack enable**
(all accepted signals on together) as its own alpha trial — 19 correlated signals
inflate best-of selection, so the composite is itself a counted trial and must
clear DSR at the inflated `nTrials` to ship.

## One-signal-at-a-time protocol

One signal at a time; pre-register (enable date, **fixed horizon, fixed N**,
and the **three-sentence mechanism** — who is on the other side; why they lose
or pay; what friction stops professionals from closing it — without which the
gates refuse the row as parameter-fishing) before reading; recalibrate
`conviction_threshold` after any score-affecting change (and log that as its
own row). **No sequential peeking** — no early accept
on a good week, no disable on a bad week; any mid-soak toggle restarts the count.
Test order (cheapest-to-disprove / most data-dense / safest first):

1. `cost_scalar` → 2. `participation` → 3. `amihud` → 4. `dispersion` →
5. `regime.vol`/`gross` → 6. `portfolio.target_vol`/`inverse_vol`/`cov`
**— then the sparse directional/alpha signals last —**
7. `regime.thresholdBump` → 8. `anti_chase` → 9. `low_vol` → 10. `trend_gate` →
11. `gap` → 12. `risk_off`/`drawdown_throttle` → 13. `calibration` (walk-forward
mandatory).

## Timeline & the honest N

Disprove funnel (Stages 0–4): **days**, cheap, kills most weak signals fast. The
accept path is **slow and serial**: "≥50 ACTIVE trades" means 50 closed trades in
which *that* signal fired — a signal active on a fraction of trades needs a
multiple of 50 total closed trades. RTH-only, one daily thesis, `max_open_names`
small → **many months to multi-year per signal, run serially**. Realistic outcome:
the backtest kills most cheaply; the soak plausibly accepts **one or two signals
over many months**; the rest stay flag-off. Undecided ≠ failed.

## SIP decision

**Defer the paid SIP subscription.** Validate the fill-quality signals in the
backtest shadow on the existing `backtest-data/daily-sip/*` first. Live SIP's only
real unblock is re-enabling premarket/afterhours (currently off, commit 28c1f65);
since only RTH is live and RTH spread is tolerable on IEX, subscribe **only after**
(a) an RTH edge is established in the soak AND (b) the shadow shows cost_scalar /
participation cut net cost without killing fills under the pessimism stress.

## False-conclusion guardrails

| Risk | Defense |
|---|---|
| Accepting on the backtest alone (~1 regime, <50 trades) | Backtest disproves only; acceptance needs the live soak. |
| LLM trained on the window (undetectable) | Standing registry caveat; accept only on future soak data. |
| Beta-timing posing as alpha | Every scalar must beat an equal-magnitude uniform gross haircut on Sharpe. |
| Grading a gate on optimistic imputed fills | Run gate OFF live, shadow-flag vetoes, measure realized P&L. |
| H-stratum cherry-picking | Quote `designWeightedEstimate` only, never the H figure. |
| Multiple testing across 19 correlated signals | `deflatedSharpe` > 0.95 at registry-derived `nTrials`; composite is a counted trial. |
| Floor-bound scalar attributed as 0 | Leave-one-out only; never divide a scalar out. |
| Optional stopping / peeking | Pre-committed fixed N + horizon; any toggle restarts the count. |
| Killing a tail-hedge that's flat on mean P&L | Judge on drawdown/CVaR in the regime it targets (per-regime slice). |
| Budget-cascade blind spot | Decide on the full re-run; per-trade arithmetic is explanatory only. |

## Bottom line

The backtest is a **disproof machine**; the paper soak is the **only accept
path**; and honestly, the data will likely let you accept **at most one or two**
of the 19 signals over a long horizon, with the rest staying flag-off. Book-
variance guardrails (portfolio vol-targeting, shrinkage cov, regime-vol scalar)
are the exception where backtest evidence is admissible because their metric
doesn't depend on the optimistic fill model. Declaring more than this — an
economic edge from the backtest, or an accept before ≥50 active OOS trades clear
the deflated-Sharpe gate — would be the cardinal sin.
