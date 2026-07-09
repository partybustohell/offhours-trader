# Quant techniques for the all-sessions trader — design

Date: 2026-07-09. Branch: `quant-p0`.

## Context

The off-hours trader now trades all US equity sessions (premarket, RTH,
afterhours; weekdays; no crypto). Its alpha is 100% LLM-driven (5 analysts
nominate + vote → deterministic synthesis) and the config records **no positive
edge at any threshold**. The backtest window is ~6 months (≈1 regime
observation) with ~7–13 historical trades and zero out-of-sample closed trades;
it cannot discriminate small edges. Therefore the honest deliverable is not
"proven alpha" but: (1) fix a real correctness issue, (2) risk/cost guardrails
that are safe by construction, (3) signal machinery built **flag-OFF** with
pre-registered rules, enabled only after the paper soak accumulates ≥50 OOS
closed trades.

Research: five surfaces (alpha signals, sizing/portfolio, regime/risk,
execution, integration+reality-check) were each researched and adversarially
verified (workflow `wf_d4e2b3d4-1f6`, 11 agents). Synthesis produced a prioritized
P0–P3 plan; advisor review sharpened the phasing and flagged the feed-dependence
split. Decisions taken with the user:

- **24/7 = all US sessions** (no crypto).
- **Build feed-independent P0 now**; roadmap P1–P3 flag-off.
- **Stay on free IEX**; SIP-only gates ship dormant.
- **Alpha signals are size-reducers only** (accept partial LLM overlap; never a
  directional vote).
- **No overnight-flatten gate** (it contradicts the off-hours-carry product).

## Composition invariant (ethos-preserving)

The LLM `weightedConviction` is never modified or blended into. Deterministic
code enters only as: (a) **fail-closed gates** that remove trades; (b)
**down-only size multipliers** (mirroring the existing `volScalar`), combined
multiplicatively **with a floor** so stacked scalars can never collapse the book
to a de-facto skip; (c) **ordering/count discipline**. No deterministic feature
is ever injected into LLM prompts (avoids double-counting). Regime, when it
ships, enters as a discrete threshold-bump OR a size scalar — never both at full
strength on one signal.

## P0 — feed-independent (implement + unit-test this session)

Each item is safe by construction: it can only remove or shrink trades, reorder
them, or change backtest/report output. None can add risk or cast a directional
vote.

### 1. Conviction-priority deploy ordering — `src/synthesis.ts`
`computeThesisEntries` returns entries in candidate order, which traces to
`candidates.ts` nomination-count/dollar-volume sort — **not** conviction. When
the executor's 10% daily-deploy cap binds, lower-conviction names can fund
first and starve better ones. Fix: sort `entries` desc by `weightedConviction`
before return. `deploy_priority: 'conviction' | 'conviction_per_risk'` (default
`conviction`); `conviction_per_risk` divides by `realizedVolAnnualized` (missing
vol → treated as 1, i.e. sorts after equal-conviction vol-known names). Tie-break
deterministically by ticker.
- Tests: 3 tickers, conviction inverse to nomination count → `entries[0]` is
  highest-conviction; `conviction_per_risk` reorders by conviction/vol; stable
  tie-break by ticker.

### 2. Min-position floor + max-open-names cap — `src/synthesis.ts`
After sizing + the sort: drop entries with `targetNotionalUsd <
min_position_notional_usd` (skip reason `below min position`); then truncate to
`max_open_names`, keeping the highest-conviction survivors (overflow → skip
reason `over max_open_names`). Kills whole-share quantization dust and capital
fragmentation. Caps the **thesis plan**, not live cross-day concurrency (that is
item 4). Config: `min_position_notional_usd` (250), `max_open_names` (3).

**Default coherence (from review):** `max_open_names` must satisfy
`max_open_names × max_position_pct ≤ max_gross_exposure_pct`, else the gross
backstop (item 4) binds first and the name cap is dead. Shipped coherent:
3 × 5% = 15% = `max_gross_exposure_pct`. **Small-account caveat:** the sizing
base is `min(max_order_notional_usd, equity × max_position_pct)`; at equity
below ~$5k the 5%-of-equity base shrinks so `base × conviction` can fall under
the $250 floor and silently drop the marginal low-conviction entries the paper
soak needs to accumulate ≥50 trades — lower `min_position_notional_usd`
proportionally for small accounts. Confirm the actual paper/live equity before
relying on the defaults.
- Tests: sub-floor dropped with reason; count ≤ cap; the retained set is the
  top-conviction names; ordering preserved.

### 3. Entries-only timing blackouts — new `src/session-risk.ts`
Pure `entryTimingAllowed(session, minutesET, cfg): boolean`. Blocks **entries**
in the RTH open window `[570, 570+rth_open_min)` (09:30–09:40) and pre-close
`[960-rth_close_min, 960)` (15:50–16:00), and outside the tradable-liquidity
window in extended hours: premarket before `premarket_start_hm`, afterhours at/
after `afterhours_end_hm`. Wall-clock only → feed-independent. Wired into the
executor **entry loop only**; the exits loop is never gated. Config:
`entry_blackout: { rth_open_min: 10, rth_close_min: 10, premarket_start_hm:
"08:00", afterhours_end_hm: "18:00" }`.
- Tests: boundary table (09:39 block / 09:40 allow; 15:49 allow / 15:50 block;
  premarket 07:59 block / 08:00 allow; afterhours 17:59 allow / 18:00 block);
  `closed` always blocked; the predicate is pure.

### 4. Cross-day gross / net exposure caps — `src/risk.ts`
Entry-only, defense-in-depth backstop above the per-day deploy cap. Reject when
`Σ|position.marketValue| + thisNotional + restingEntryNotional >
equity·max_gross_exposure_pct/100` (`exceeds max gross exposure`), or signed
`Σ(long−short) marketValue + signedThisNotional` exceeds
`equity·max_net_exposure_pct/100` (`exceeds max net exposure`). `restingEntryNotional`
= Σ over `openOrders` tagged `entry-` (clientOrderId prefix; matches
`seedDeployedTodayUsd`). Exits always allowed. Config: `max_gross_exposure_pct`
(15), `max_net_exposure_pct` (12).
- Tests: gross breach rejects entry; net cap on a directional book; exits pass;
  reason accumulation unaffected; existing risk tests stay green (defaults large
  enough that current fixtures don't trip).

### 5. Multiple-testing governance — `src/backtest/metrics.ts` + report + `docs/TRIAL-REGISTRY.md`
- Pure `deflatedSharpe(observedSR, nTrials, skew, kurt, nObs)` (Bailey/López de
  Prado): deflates the observed Sharpe for the number of trials tried, returning
  the probability the true SR > 0. Tested against hand-computed values.
- Min-N economic-claim gate: `renderReport` accepts
  `meta.minTradesForEconomicClaim`; when set and the headline stratum's
  `nTrades < ` it, the economic bar prints **"insufficient n — no economic
  verdict"** instead of PASSES/FAILS. Default undefined → current behavior
  (existing test stays PASSES). Config: `min_trades_for_economic_claim` (50);
  the backtest driver passes it into `meta`.
- `docs/TRIAL-REGISTRY.md`: append-only log of every config/threshold/signal
  variant tested, so multiple-testing is explicit and `nTrials` for the deflated
  Sharpe is honest.
- Tests: `deflatedSharpe` monotonicity + a pinned value; report emits the
  insufficient-n line below the floor and a verdict above it.

### 6. Backtest fill-model realism — `src/backtest/fills.ts`
Add optional `marketable?: boolean` to `FillOrderSpec` (default `true` =
current strict-cross-on-touch-through behavior, so all existing tests and the
live path are unchanged). Passive (`marketable: false`) requires a genuine
trade-**through** (`bar.l < L − tick` for buys, `bar.h > L + tick` for sells)
and a heavier volume guard (`PASSIVE_VOLUME_GUARD_MULTIPLE`, 40× vs 20×). Makes
the future semi-passive placement (P3) honestly testable. Backtest-only.
- Tests: marketable fills on touch-through (unchanged); passive needs trade-
  through and clears the heavier guard; a touch that fills marketable does not
  fill passive.

### Config plumbing
All new keys added to `ConfigSchema` (zod, with defaults). Nested objects
(`entry_blackout`) added to `saveConfig`'s key-by-key merge list so the
dashboard PATCH never resets them. `config.yaml` gets the new keys with comments.
GET `/api/config` already returns the whole config → the dashboard sees the new
fields with no server change.

## Roadmap — P1–P3 (built later, flag-OFF, pre-registered)

Enabling gate for ALL of the below: no signal leaves flag-off, and no
economic-edge claim is emitted, until the paper soak accumulates ≥50 OOS closed
trades. Every one ships disabled with a pre-registered rule.

- **P1** (reduce-only tilts / ex-ante cost pruning): spread-cost `costScalar`
  sizing multiplier; anti-chase (short-term reversal) haircut + band-tighten;
  Amihud illiquidity cost gate; participation cap vs displayed top-of-book;
  SPY-trend direction-aware regime gate. Feed-gated items (session-calibrated
  spread/staleness/min-size gates, round-trip cost gate, participation) stay
  dormant on IEX — activate only when `data_feed: sip`, and default to today's
  values so they never loosen or silently stop trading.
- **P2** (priors-driven, backtest cannot discriminate at this n): portfolio-
  level ex-ante vol target; shrinkage-covariance correlation-aware sizing;
  conviction-tilted inverse-vol basket weighting (`sizing_mode`); SPY realized-
  vol regime scalar; index-TSMOM gross-exposure scalar; analyst-dispersion
  sizing multiplier (ships inert, k=0); vol-scaled bands + stop; drawdown-based
  book throttle (high-water mark in `state.ts`); live risk-off shock halt.
- **P3** (speculative directional / deferred): catalyst-gap continuation (gate
  off-hours, RTH-open entry only); 12-1 + 52-week-high counter-trend veto (the
  one genuinely LLM-invisible signal — analysts see only 25 bars); low-vol
  candidate-ranking tiebreak; spread-fraction semi-passive placement (needs the
  fill-model fix from P0 item 6); monotone conviction calibration (isotonic/
  Platt, needs ≥50 OOS trades).

## Data gaps (carried forward)

- **SIP vs IEX** gates the session-microstructure set, the Amihud/ADV cost gate,
  and honest off-hours execution. Staying on IEX for now → those ship dormant.
- No earnings-estimate/SUE feed → true PEAD not computable; the gap signature
  (gapPct + relVolume) is the proxy, and identifying it as a catalyst is the
  LLM's job via news.
- Live daily bars are raw-adjusted → a split distorts 12-1 momentum; use
  adjusted bars or a split guard for the trend feature.
- No spot VIX / L2 depth / GICS sector feed → implied-vol regime, depth-aware
  participation, and sector caps dropped; SPY realized-vol and top-of-book size
  are the in-feed substitutes.
- Conviction calibration & any conviction→edge (Kelly) map need ≥50 OOS closed
  trades — a data-availability gap, not a feed gap.

## Implementation status (2026-07-09)

P0 shipped (enabled, safe-by-construction). **P1–P3 are now all BUILT and wired,
shipping flag-OFF** — the machinery is deterministic and unit-tested, and every
signal is disabled by default. New modules: `src/signals.ts` (features + down-only
scalars + gates), `src/regime.ts` (trend/vol/gross overlay), `src/portfolio.ts`
(shrinkage covariance, vol targeting, inverse-vol weights), `src/calibration.ts`
(identity map). Integration: `synthesis.ts` applies calibration → threshold-bump →
per-name down-only scalars (floored product, volScalar kept separate so legacy
sizing is byte-identical when off) → gates → whole-book portfolio pass;
`executor-loop.ts` applies cost scalar, participation cap, drawdown throttle,
risk-off freeze, session-calibrated gates (SIP-only), and semi-passive placement;
`pipeline.ts` computes features + market regime from SPY and stores the regime on
the thesis. Config for every knob is in `ConfigSchema`. **Enabling remains gated
on the paper soak (≥50 OOS trades); log each trial in `docs/TRIAL-REGISTRY.md`.**

## Non-goals

Crypto; ML models that can't be deterministically unit-tested; any change to the
LLM analyst/judge prompts to inject deterministic features; enabling any P1–P3
signal this session; emitting an economic-edge claim before the paper soak.

## Test strategy

TDD per item, extending the existing vitest suites (`synthesis.test.ts`,
`risk.test.ts`, `backtest-fills.test.ts`, `backtest-metrics.test.ts`,
`config.test.ts`) and a new `tests/session-risk.test.ts`. Pure functions
everywhere; boundary tests on every gate. Full suite (currently 302 tests) must
stay green; `pnpm typecheck` clean.
