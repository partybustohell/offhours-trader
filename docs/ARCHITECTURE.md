# Off-Hours Trader — Architecture & Reference

A multi-agent, LLM-driven US-equities trading system with a deterministic
risk-and-execution core. This document is the full technical reference: what it
is, how it decides, how it executes, how it's tested, and how to operate it.

> **One sentence:** LLM analyst agents *discover and argue about* what to trade;
> plain, unit-tested code decides *how much, when, and whether* — then places the
> orders. That division of labour is the entire design philosophy.

- [1. Philosophy](#1-philosophy)
- [2. System shape — two loops](#2-system-shape--two-loops)
- [3. Phase 1 — the pipeline (build the thesis)](#3-phase-1--the-pipeline-build-the-thesis)
- [4. Phase 2 — the executor (trade the thesis)](#4-phase-2--the-executor-trade-the-thesis)
- [5. Position sizing](#5-position-sizing)
- [6. Risk controls](#6-risk-controls)
- [7. The quant layer](#7-the-quant-layer)
- [8. Data, feeds, and the broker](#8-data-feeds-and-the-broker)
- [9. Modes and safety](#9-modes-and-safety)
- [10. Configuration reference](#10-configuration-reference)
- [11. The backtest harness](#11-the-backtest-harness)
- [12. The quant testing plan](#12-the-quant-testing-plan)
- [13. Operations](#13-operations)
- [14. Dashboard](#14-dashboard)
- [15. Current live state](#15-current-live-state)
- [16. Honest limitations](#16-honest-limitations)
- [17. Module map](#17-module-map)

---

## 1. Philosophy

The system separates **judgment** from **decision**:

- **LLMs** (Claude) do only what language models are good at: read scans and news,
  nominate tickers, argue a direction with a conviction, write narratives, and
  **veto** an open position. They can never size a position, choose a price, or
  place an order.
- **Deterministic code** (fully unit-tested, no randomness beyond a seeded
  bootstrap) does everything money-touching: conviction math, position sizing,
  limit bands, pre-trade gates, exposure caps, the hard stop, order construction,
  and the daily-loss kill switch.

Consequences that follow from this rule:

- Every economic decision is reproducible and testable.
- An LLM hallucination can, at worst, propose a bad *idea*; it cannot bypass a
  cap, a stop, or a spread gate.
- The system is **file-driven**: the pipeline writes JSON; the executor reads it;
  the dashboard reads the same files. Delete `out/` and nothing else breaks.

---

## 2. System shape — two loops

```
① BUILD THE THESIS  (pipeline — once per session)
   market scans ─▶ 5 analysts NOMINATE ─▶ filter ─▶ 5 analysts VERDICT ─▶ synthesis ─▶ thesis.json
        code            LLM                 code          LLM              code           file
                                                                             │
② TRADE IT  (executor — every 15 min)                                        ▼
   session gate ─▶ load thesis ─▶ EXITS (stop + judge) ─▶ ENTRIES (gates + judge) ─▶ risk gate ─▶ Alpaca
        code           code          code + LLM               code + LLM              code       (paper)
```

Two independent processes, scheduled separately:

- **Pipeline** (`pnpm pipeline`) — run once per weekday (evening for the
  off-hours thesis, morning for the regular-session thesis). Produces a thesis.
- **Executor** (`pnpm tick`) — run every 15 minutes. Reads the active thesis,
  monitors positions, opens/closes within gates. Exits immediately if the current
  session is closed or disabled.

There are two **thesis kinds**: `offhours` (traded during pre-market/after-hours)
and `rth` (traded during the regular session). The executor picks the right one
for the current session.

---

## 3. Phase 1 — the pipeline (build the thesis)

`src/pipeline.ts`. Steps, in order:

1. **Scans** (code) — `AlpacaMarketData.getMovers()`, `getMostActives()`,
   `getNews()`. This is the raw universe the analysts see.
2. **Round 1 — Nominate** (LLM) — five analyst agents, each with a distinct
   system prompt and mandate, independently pick tickers from the scans:

   | Analyst | Mandate | Default weight |
   |---|---|---|
   | `fundamental` | valuation, earnings, guidance | 1.0 |
   | `technical` | price/volume structure | 0.8 |
   | `macro` | rates, sectors, regime | 0.6 |
   | `sentiment` | news, flow, positioning | 1.0 |
   | `bear` | adversarial — argues the short/downside | 1.2 |

   Each returns `{ticker, reason}` items (`src/agents/nominate.ts`).
3. **Filter → candidates** (code, `src/candidates.ts`) — union the nominations,
   drop excluded tickers, drop `price < min_price` ($5) and
   `avgDollarVolume20d < min_avg_dollar_volume` ($20M), rank by nomination count
   then dollar volume, cap at `max_candidates` (15). Output: `candidates-*.json`.
4. **Round 2 — Verdict** (LLM, `src/agents/verdicts.ts`) — the same five analysts
   each render a **structured verdict** per candidate:
   `{direction: long|short|none, conviction: 0..1, horizon, evidence[], invalidation_conditions[]}`.
   The analysts see recent daily-bar summaries and per-ticker news.
5. **Synthesis** (code, `src/synthesis.ts`) — the deterministic heart. Per ticker:
   - **Quorum**: need ≥ `quorum` (3) verdicts of any direction, else skip.
   - **Directional-weight-normalized score**: `Σ(weight·conviction) / Σ(directional weight)`, computed per side. Abstentions (`none`) count toward quorum but never dilute a side; opposing directional votes *do* dilute (that's how the bear's veto power flows through real contrary verdicts, not silence).
   - **Disagreement gate**: if both long and short scores ≥ 0.3, skip (too split).
   - **Agreement quorum**: the winning side needs ≥ `min_agreeing` (2) analysts.
   - **Threshold**: winning `weightedConviction` must clear `conviction_threshold` (0.55, plus any regime threshold-bump).
   - **Sizing** → target notional (see §5), **limit band**, and the union of the winning side's invalidation conditions.
   - Entries are then **sorted by conviction** (so the daily-deploy budget funds the best names first), dropped below the **min-position floor**, and capped to **max_open_names**.
6. **Narrative** (LLM, `src/agents/narrative.ts`) — writes a human-readable
   rationale and merges/dedupes invalidation conditions per entry.
7. **Write** — `thesis-YYYY-MM-DD[-rth].json` plus an append to `audit-*.jsonl`.

A **thesis entry** is `{ticker, direction, weightedConviction, limitBand,
targetNotionalUsd, narrative, invalidationConditions}` (+ an optional `sizing`
counterfactual record used by the testing harness).

---

## 4. Phase 2 — the executor (trade the thesis)

`src/executor-loop.ts`, `runTick()`. Each tick:

1. **Session gate** — `currentSession()` (ET). If the session is `closed` or
   disabled in config, log and return. Sessions: premarket 04:00–09:30,
   rth 09:30–16:00, afterhours 16:00–20:00 (weekdays).
2. **Cross-process lock** — a file lock ensures a cron tick and an
   API-triggered tick never run concurrently (no duplicate orders).
3. **Snapshot** — account, open orders, daily P&L, today's orders. If daily P&L
   ≤ `-daily_loss_halt_pct` of equity, write the **halt** state (kill switch).
4. **Load the active thesis** — the unexpired thesis for the session's kind
   (RTH uses today's `rth` thesis; pre/after-market use today's or yesterday's
   `offhours` thesis). A corrupt file aborts the tick; a missing file is a no-op.
5. **Quotes** — fetch latest quotes for all thesis tickers *and* every open
   position. **Staleness guard (fail-closed)**: drop any quote older than
   `max_quote_age_sec` (120s) vs the tick clock — this is what makes the free IEX
   feed *safe* in the deep off-hours it can't see (it abstains instead of
   trading a stale book).
6. **Exits first** (closing risk precedes opening it) — for every open position:
   - **Deterministic hard stop** (checked before any LLM): if unrealized loss ≥
     `max_position_loss_pct` (8%), exit. This stop applies to **every** open
     position, including ones with no thesis entry (e.g. a seeded basket), so a
     held book is always stop-protected. A loss limit is risk management, not a
     judgment call.
   - Otherwise, if the position has a thesis entry, the **LLM judge**
     (`src/agents/judge.ts`) re-reads fresh news against the invalidation
     conditions and may veto (exit). The judge can only *close*, never open.
   - Exits are marketable limit orders, cent-rounded to the passive side.
7. **Entries** — only outside the entry-timing blackout windows. For each thesis
   entry, a stack of **code gates** must all pass: no existing position/order,
   spread ≤ `max_spread_bps` (50), top-of-book size ≥ 1, last price inside the
   limit band, quote fresh. Then the **judge** must approve. Then the
   deterministic **risk gate** (§6). Regular-session entries carry a native
   Alpaca stop-loss leg (extended-hours stops don't execute at any broker).
8. **Audit** — every proposal, placement, rejection, exit, halt, and skip is
   appended to `audit-*.jsonl`.

---

## 5. Position sizing

All in `src/synthesis.ts`, all deterministic:

```
baseNotional   = min(max_order_notional_usd, equity × max_position_pct/100)
volScalar      = min(1, target_vol_pct/100 ÷ realizedVolAnnualized)   # risk-parity, only shrinks
signalProduct  = max(signal_scalar_floor, ∏ down-only signal scalars)  # 1.0 when signals off
targetNotional = round( baseNotional × weightedConviction × volScalar × signalProduct )
```

- **`volScalar`** equalizes dollar risk across names: an 80%-vol name gets half
  the size of a 40%-vol name. It never levers *up* past the cap.
- **`signalProduct`** is the product of the P1–P3 down-only signal scalars,
  floored so stacking can't collapse a position to a de-facto skip. With every
  signal off (the default) it is exactly 1.0, so sizing is unchanged.
- Whole-book overlays (portfolio vol-targeting, inverse-vol weighting) can rescale
  the set afterward when enabled.

Qty at execution = `floor(targetNotional / limitPrice)`; sub-one-share targets are
skipped.

---

## 6. Risk controls

The deterministic **risk gate** (`src/risk.ts`) runs at order placement and
collects *all* failing reasons (no short-circuit). Entry-only rules never block an
exit — closing risk is always allowed.

| Rule | Applies to | Blocks when |
|---|---|---|
| Trading halted | entries | halt state is set |
| Daily-loss kill switch | entries | `dailyPl ≤ -equity × daily_loss_halt_pct` (3%) |
| Valid limit / qty | all | non-finite/≤0 price, non-integer/<1 qty |
| Exclude list | entries | ticker on `universe.exclude` |
| Max order notional | entries | `qty × price > max_order_notional_usd` |
| Max position size | entries | existing + new exposure > `equity × max_position_pct` |
| Max daily deployment | entries | today's entries + new > `equity × max_daily_deploy_pct` |
| Duplicate open order | all | an open order exists for the same ticker+side |
| **Gross exposure cap** | entries | Σ\|positions\| + resting entries + new > `equity × max_gross_exposure_pct` |
| **Net exposure cap** | entries | signed Σ + new > `equity × max_net_exposure_pct` |

Beyond the gate: the **8% per-position hard stop** (every tick, every position),
the **native −8% broker stop** on RTH entries, the **quote-staleness guard**, the
**entry-timing blackout** (avoids the open/close vol spikes and the deep-off-hours
liquidity vacuum), and the **daily-loss halt** that latches until manually resumed.

---

## 7. The quant layer

Everything here is **deterministic code with unit tests**; no ML black boxes. Two
tiers:

**P0 — shipped ON (safe by construction — can only remove/shrink/order trades):**
conviction-priority deploy ordering, min-position floor, max-concurrent-names cap,
cross-day gross/net exposure caps, entries-only timing blackout, the universal
hard stop, and multiple-testing governance (deflated Sharpe, min-N economic-claim
gate, a typed trial registry enforced by preflight).

**P1–P3 — built but shipped OFF (flag-off, pre-registered):**

- *Alpha signals:* anti-chase (short-term reversal) haircut, Amihud illiquidity
  haircut, 12-1 / 52-week-high counter-trend veto, catalyst-gap veto, low-vol
  tiebreak, analyst-dispersion sizing.
- *Sizing / portfolio:* whole-book vol targeting, shrinkage-covariance sizing,
  conviction-tilted inverse-vol weighting.
- *Regime:* SPY trend/vol/gross overlay → down-only direction & vol scalars + a
  discrete conviction-threshold bump.
- *Execution:* spread-cost scalar, participation cap, semi-passive placement,
  session-calibrated SIP-only gates.
- *Risk:* drawdown throttle, intraday risk-off freeze.
- *Calibration:* monotone conviction map (ships as identity).

**Composition invariant:** the LLM `weightedConviction` is never modified or
blended into. Signals enter only as (a) fail-closed gates, (b) down-only size
multipliers combined multiplicatively with a floor, or (c) a discrete
threshold-bump. No deterministic feature is ever injected into an LLM prompt
(avoids double-counting what the analysts already read). Nothing is enabled until
the paper soak justifies it (§12).

---

## 8. Data, feeds, and the broker

- **Market data & broker:** Alpaca. Free paper account provides both.
- **Feeds** (`data_feed`): `iex` (free — blind in the deep off-hours 17:00–08:00
  ET, so the staleness guard makes the executor abstain there; fully covers the
  regular session) or `sip` (paid — the consolidated tape, required to actually
  trade extended hours).
- **Derived data:** `realizedVolAnnualized` = std of close-to-close log returns ×
  √252; `avgDollarVolume20d` over trailing 20 days; per-name signal features
  (recent return, Amihud, 12-1 momentum, 52-week-high proximity, gap signature)
  computed by the shared `computeTickerFeatures` (`src/signals.ts`) so the live
  pipeline and the backtest driver enrich identically.

---

## 9. Modes and safety

| Mode | Orders | Keys |
|---|---|---|
| `dry-run` | none (logged) | paper (reads only) |
| `paper` | paper account | `ALPACA_PAPER_*` |
| `live` | **real money** | `ALPACA_LIVE_*` |

Going live requires **all three** deliberate steps, or the system refuses to
start (never silently falls back to paper): live keys in `.env`, `mode: live` in
`config.yaml` **by hand**, and `live_trading_acknowledged: true` **by hand**. The
dashboard cannot flip `mode` or the acknowledgment — `PUT /api/config` pins both
to their on-disk values.

---

## 10. Configuration reference

`config.yaml` (validated by a zod schema in `src/config.ts`; editable from the
dashboard except the two live-mode fields). Selected knobs:

| Key | Default | Meaning |
|---|---|---|
| `mode` | `paper` | dry-run / paper / live |
| `universe.min_price` / `min_avg_dollar_volume` | 5 / 20M | candidate filters |
| `universe.max_candidates` | 15 | candidate cap |
| `sessions.{premarket,afterhours,regularhours}` | off/off/on* | which sessions trade |
| `agent_weights.*` | F1.0 T0.8 M0.6 S1.0 B1.2 | analyst weights |
| `conviction_threshold` | 0.55 | min weighted conviction to trade |
| `quorum` / `min_agreeing` | 3 / 2 | verdicts needed / agreeing side |
| `max_position_pct` | 5 | per-name cap (% equity) |
| `max_daily_deploy_pct` | 10 | daily deployment cap |
| `target_vol_pct` | 40 | risk-parity sizing reference |
| `max_position_loss_pct` | 8 | per-position hard stop |
| `max_order_notional_usd` | 2000 | per-order cap |
| `max_spread_bps` | 50 | entry spread gate |
| `data_feed` | `iex` | iex / sip |
| `max_quote_age_sec` | 120 | staleness guard |
| `daily_loss_halt_pct` | 3 | kill switch |
| `deploy_priority` | `conviction` | funding order |
| `min_position_notional_usd` | 250 | dust floor |
| `max_open_names` | 5* | concurrency cap |
| `max_gross_exposure_pct` / `max_net_exposure_pct` | 25 / 25* | cross-day backstops |
| `entry_blackout` | 10/10 min, 08:00–18:00 | timing gate |
| `min_trades_for_economic_claim` | 50 | report governance gate |
| `signals.*`, `regime.*`, `portfolio.*`, `execution.*`, `risk_overlay.*`, `calibration.*` | all off | P1–P3 signals |
| `model.{analysts,synthesizer,executor}` | sonnet/fable/sonnet | per-role model |

\* Current operational values: off-hours sessions disabled (regular-hours only);
`max_open_names` and exposure caps raised to hold the seeded starter basket.

---

## 11. The backtest harness

`scripts/backtest.ts` + `src/backtest/*`. A statistically disciplined episode
backtest, not a naive replay:

- **Stratified episode protocol** — random-day stratum **R** (the headline) and a
  top-cross-sectional-dispersion stratum **H** (never pooled into the headline).
- **Deterministic LLM cache** — exact replay; the same seed yields the same run.
- **Fill model** (`src/backtest/fills.ts`) — strict limit-cross vs SIP minute bars,
  a 20× per-session volume guard, no partials. Explicitly **optimistic** vs real
  extended-hours execution; a passive/marketable distinction supports the P3
  placement signal.
- **Costs** — the 2026 FINRA/SEC fee schedule (date-keyed) + ETB borrow accrual.
- **Statistics** (`src/backtest/metrics.ts`) — seeded bootstrap CIs, Wilson
  intervals, a design-weighted full-window estimate, per-analyst attribution, and
  the **deflated Sharpe** (Bailey/López de Prado) with an honest trial count.
- **Leakage/look-ahead probe** — masked-vs-unmasked verdict controls.
- **Governance** — the report refuses an economic PASS/FAIL below
  `min_trades_for_economic_claim`.

**Signal testing tools** (Stage 1 of the testing plan):

- `sweep --signals` — a baseline vs one-signal-on cell grid; cells share cached
  LLM inputs (signals never enter the prompt), so it's a clean same-inputs
  counterfactual. Flags: `--feed sip|iex`, `--threshold`, `--no-blackout`,
  `--budget-only` (free cost check), `--budget-limit`.
- `attributions --tag T` — per-signal **paired** per-episode net-P&L diff vs
  baseline with a bootstrap CI and a keep/**KILL** verdict.
- `walkforward --tag T --k 3` — sequential K-fold economics (overfit guard).

Every thesis entry carries a leave-one-out `sizing` counterfactual
(`attributeScalars`, recomputed never divided out — the floor makes the product
non-additive), and the pipeline emits a `counterfactual` audit event, so a
signal's marginal effect is attributable.

---

## 12. The quant testing plan

`docs/QUANT-TESTING-PLAN.md`. The governing rule:

> **The backtest is licensed only to DISPROVE a signal. Acceptance is earned only
> on the live paper soak.**

Why the backtest can't accept: ~1 regime observation, few trades, analyst LLMs may
have trained on the window (undetectable by any probe), and the fill model is
optimistic exactly where execution signals operate. The staged plan: validity
probes → build counterfactual instrumentation → backtest disprove funnel →
variance-guardrail validation → **paired-counterfactual paper soak** (the only
accept path: ≥50 out-of-sample trades where the signal was *active*, CI excludes 0,
beats a uniform-haircut placebo) → deflated-Sharpe gate at the registry-derived
trial count. Signals are enabled **one at a time**, pre-registered in
`trial-registry.yaml` (enforced by `preflight`), with no sequential peeking.

Empirically confirmed: at the current backtest n, **no signal clears the
CI-excludes-0 bar** — every one reads KILL. That is the disprove funnel working;
the paper soak remains the real test.

---

## 13. Operations

```bash
pnpm install
cp .env.example .env          # ANTHROPIC_API_KEY, ALPACA_PAPER_KEY/SECRET
pnpm build:frontend
pnpm preflight                # read-only go/no-go check (keys, broker, halt, registry gate)
pnpm pipeline                 # evening off-hours thesis   (add `rth` for the morning RTH thesis)
pnpm tick                     # one executor tick (no-op outside enabled sessions)
pnpm serve                    # dashboard + API (PORT env, default 4310)
pnpm seed                     # demo data so the dashboard renders without keys
pnpm test                     # unit + integration suite
pnpm typecheck
```

**Scheduling (macOS launchd)** — `bash scripts/install-schedule.sh` writes three
jobs (evening pipeline 17:05 ET, morning RTH pipeline 09:00 ET, executor every
15 min) with times **converted to the machine's local timezone** at install (so
it's correct on a non-ET box). They're written **unloaded**; `launchctl load`
them to start. Re-run the installer after a US DST transition to re-pin the times.

**Backtest** — `sample → precompute → run → report`, plus `sweep`/`attributions`/
`walkforward` for signal testing (§11).

---

## 14. Dashboard

`src/server.ts` (Express API) + `frontend/` (React + Vite, the "Instrument" dark
terminal). Binds to localhost, **no auth — do not expose it**. Reads the same
`out/` files. Views: Overview (thesis in force, exposure, live activity, a
next-tick countdown), Thesis, Positions, Backtest, Config (edits `config.yaml`
except the two live-mode fields), Audit. `PUT /api/config` treats the body as a
patch and pins `mode`/`live_trading_acknowledged`.

---

## 15. Current live state

- **Paper account**, **regular-hours only** (off-hours sessions disabled).
- A **seeded 5-name starter basket** (NVDA, WMT, BAC, XOM, GE — a diversified,
  liquid, landmine-screened set) is held with native −8% stops and a managing
  thesis; the universal hard stop + judge manage exits.
- On a **launchd schedule** (RTH pipeline + 15-min tick).
- All P1–P3 signals **off**; no economic-edge claim is emitted.

---

## 16. Honest limitations

- **No positive edge is established at any threshold.** The config records this;
  the paper soak is the test.
- **Optimistic backtest fills** — real extended-hours execution is worse than the
  strict-limit-cross model; treat backtest economics as an upper bound.
- **IEX is blind in the deep off-hours** and mismeasures spread/ADV; SIP (paid)
  is required for honest extended-hours trading and the microstructure signals.
- **Between ticks (15 min) there is no protection** in extended hours (stops don't
  execute there); the executor monitors invalidation itself and exits with limit
  orders. An overnight/earnings gap can jump the level.
- **Market holidays are treated as weekdays** (the broker rejects those orders).
- **The dashboard has no auth** — localhost only.

---

## 17. Module map

| Path | Responsibility |
|---|---|
| `src/pipeline.ts` | orchestrates scan → nominate → filter → verdict → synthesize → thesis |
| `src/candidates.ts` | candidate filtering/ranking; `realizedVolAnnualized` |
| `src/synthesis.ts` | deterministic conviction math + sizing + ordering/floor/cap |
| `src/executor-loop.ts` | the tick: session gate, exits, entries, `positionLossPct`, lock |
| `src/risk.ts` | deterministic risk gate (all rules) |
| `src/signals.ts` | pure P1–P3 features, down-only scalars, gates, `attributeScalars` |
| `src/regime.ts` | SPY trend/vol/gross regime overlay |
| `src/portfolio.ts` | shrinkage covariance, vol targeting, inverse-vol weights |
| `src/calibration.ts` | monotone conviction map (identity by default) |
| `src/session-risk.ts` | entry-timing blackout + session-calibrated gates |
| `src/clock.ts` | ET sessions + `nowET` |
| `src/config.ts` | zod schema, load/save (PATCH), live-mode assertions |
| `src/trial-registry.ts` | typed registry + the preflight alpha-flag gate |
| `src/state.ts` | halt state + peak-equity high-water mark |
| `src/audit.ts` | append-only decision log |
| `src/agents/*` | LLM nominate / verdict / judge / narrative / prompts / client |
| `src/broker/*` | Alpaca client + market data |
| `src/backtest/*` | fills, ledger, metrics, scans, probe, LLM cache, data store |
| `scripts/*` | pipeline/tick/serve entrypoints, backtest CLI, preflight, schedule installer, seed |
| `frontend/*` | React dashboard |
| `docs/*` | this file, RUNBOOK, QUANT-TESTING-PLAN, TRIAL-REGISTRY, specs |

---

*The design in one line, again: LLMs discover and argue; deterministic code
decides, sizes, gates, and executes. Everything money-touching is testable, and
nothing claims an edge it hasn't earned on out-of-sample paper trades.*
