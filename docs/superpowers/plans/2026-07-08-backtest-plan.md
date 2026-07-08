# Backtest Plan — 2026-01-01 → 2026-07-01, $50,000

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax.
> Revision 2 — incorporates 33 confirmed findings from a 4-lens adversarial review (data feasibility, methodology, quant statistics, production parity).

**Goal:** Replay the full system — discovery, verdicts, synthesis, executor, risk gate — over every trading day from 2026-01-02 through 2026-06-30 with a $50,000 starting ledger, and answer: does this work, and under what settings?

**Architecture:** A backtest driver advances a simulated clock in 15-minute steps across the window and, at each step, calls the REAL `runTick({cfg, broker, marketData, llm, now})` with injected deps: `broker` = a ledger implementing `BrokerClient` (this is also how $50k enters, via `getAccount()`), `marketData` = historical quotes/news, `llm` = a disk-cached replay client. Theses are produced by the real `buildCandidates` → `computeThesisEntries` → `writeNarratives` merge and written via `thesisPath()` with `OUT_DIR` pointed at `backtest-out/<tag>/`, exactly like `scripts/subagent-run.ts` does today. Nothing money-relevant is mirrored; the executor's own session gate, thesis-load fallback (`today ?? yesterday`), judge, and `riskCheck` run as production code.

**Tech stack:** existing repo (TypeScript/ESM, tsx, Vitest), Alpaca Market Data v2 (paper keys), Anthropic API.

---

## 0. Prerequisites and honesty constraints

### Keys (blocking)
`.env` must contain `ALPACA_PAPER_KEY/SECRET` and `ANTHROPIC_API_KEY`. Neither exists yet.

### LLM hindsight leakage — the central validity threat
- Models under test: `claude-sonnet-5` (analysts, executor) and `claude-opus-4-8` (synthesizer), per `config.yaml`. **Verify each model's published knowledge cutoff first** (T8) and record it.
- **Headline rule:** if any in-window trading day falls on or before any used model's cutoff, the HEADLINE result becomes a fresh-start $50,000 run over the strictly post-cutoff sub-window. The full-window run is reported second, labeled leakage-contaminated. A contaminated equity curve compounds; "reporting flagged days separately" cannot decontaminate it.
- **Leakage probe (T8):** task-shaped, not direct recall — run the actual verdict prompt for (a) every (entry-date, ticker) pair the backtest actually traded and (b) ≥30 randomly sampled candidate-day/ticker pairs, each in two variants: outcome-relevant fields masked vs unmasked; plus ≥3 famous pre-cutoff events as positive controls that MUST trip. Report the detection rate with a binomial CI. If the positive controls don't trip, the report states "probe has no power" — a null result bounds leakage, it does not exclude it.
- Prompts already forbid outside knowledge; never mention "backtest" in any prompt.

### Fill realism
All fills are simulated (rules in §4). Even with real SIP tape and volume guards, results are optimistic relative to real extended-hours execution. The report says this on page one.

### No tuning-then-reporting
Headline uses shipped `config.yaml` defaults. The sweep (§5) is sensitivity analysis with a pre-registered, mechanically-selected walk-forward cell (§6) — never the headline.

## 1. Historical data layer

`src/backtest/data.ts` + `scripts/backtest-fetch.ts`. One-time download into `backtest-data/` (gitignored); all runs offline afterward.

- **Feeds — the load-bearing decision:** IEX operates only 8:00–17:00 ET; it has ZERO prints during 5 of 6 extended-hours tick windows, and its volume is ~2.5% of consolidated tape. Therefore:
  - **SIP** for: all minute bars (quotes proxy inputs, fills), movers/most-actives reconstruction (production's screener endpoints are consolidated-tape).
  - **IEX** daily bars additionally for: `marketInfoFor`/`barsSummaryFor` parity ONLY — production hardcodes `feed=iex` there, which makes `min_avg_dollar_volume` effectively ~40x stricter than face value. The backtest preserves that behavior and **surfaces it in the report as a production finding** rather than silently fixing it.
  - Historical SIP is served on the free Basic plan whenever the query end is >15 minutes in the past — always true here. **T1 acceptance probe:** for NVDA/TSLA/AAPL over one sample week, assert nonzero 1-min bar counts in 17:00–20:00 and 04:00–08:00 ET on `feed=sip` and zero on `feed=iex`; fail fast if not.
- **Adjustment:** `adjustment=raw` everywhere (matches production and keeps daily/minute data on one price basis). Splits handled by exclusion: download the corporate-actions calendar for the window; any symbol whose thesis-to-expiry span crosses a split ex-date is excluded for that span (open positions force-flattened at prior close and flagged); counts go in the validity appendix. Dividends untracked (raw prices); noted.
- **Universe:** `/v2/assets?status=active&class=us_equity`, tradable, non-OTC; **persist `shortable`/`easy_to_borrow` flags** (point-in-time proxy for H1-2026 borrowability — noted). Survivorship: current-active list; limitation recorded.
- **Daily bars:** multi-symbol `/v2/stocks/bars?timeframe=1Day&adjustment=raw`, both feeds, 2025-11-15 → 2026-07-02 (20-day runway), chunked 100 symbols/call with pagination.
- **Minute bars (SIP, raw):** fetched lazily per calendar trading day for candidates + symbols with working orders or open positions, covering 04:00 → 20:00 ET of each day involved (orders live to 20:00 — see §4).
- **Quotes/trades:** at tick times, multi-symbol historical `GET /v2/stocks/quotes` (`feed=iex`, production parity with `getLatestQuotes`) and `GET /v2/stocks/trades` windows T−15min → T, fetched lazily and cached.
- **News:** `/v1beta1/news` paged per day → full-day store; slicing in §2.
- **Calendar:** `/v2/calendar` drives the day loop. **Benchmarks:** SPY, QQQ daily bars; 3-month T-bill average yield for the window (single constant, cited in report).

## 2. Scan reconstruction (per day D, as of 17:00 ET)

`src/backtest/scans.ts` — pure, unit-tested, **mirroring production shapes exactly** (floors live ONLY inside the real `buildCandidates`):

- `moversFor(D)`: top 20 by +% and top 20 by −% day-over-day close from SIP daily bars, full universe, no floors (production `getMovers()` returns 20/20 from the consolidated-tape screener).
- `mostActivesFor(D)`: top 30 by SIP share volume, no floors (production `getMostActives()` top=30).
- `newsFor(D)`: the 50 most recent items with created_at ≤ D 17:00 ET, newest first (production `getNews()` limit=50). The uncapped (D−1 17:00, D 17:00] slice remains the store for per-candidate verdict news (production `getNews(50, tickers)` analog).
- `barsSummaryFor(sym, D)` / `marketInfoFor(syms, D)`: from **IEX** daily bars, same math as production (`lastPrice` = last close, 20-day avg dollar volume).
- Residual divergence (recorded, irreducible): the real screener ranks on real-time intraday consolidated data at the moment of the call; the reconstruction uses close-over-close SIP daily bars.

## 3. LLM replay layer

`src/backtest/llm-cache.ts` — wraps `callStructured` with two caches:
1. **Exact cache:** SHA-256 of `(model, system, toolName, user)` → response. All headline-run calls.
2. **Canonical judge cache (sweep only):** key = `(model, date, tickTime, ticker, direction, invalidationConditions-hash, quote-hash, headlines-hash, position-side)` — deliberately EXCLUDING weightedConviction, targetNotionalUsd, limitBand, and position qty/avg-entry. Sweep cells share judge decisions through it; the stated approximation (judge is sizing/band-invariant) goes in the validity appendix. Only entry situations that exist solely at looser thresholds incur fresh calls; the driver counts and reports them.

Both caches **store per-call token usage and model** so the report can sum actual $ spent and project live operating cost/day.

**Phase A (parallel across days, ~8-way):** per day: nominations (5 calls) → real `buildCandidates` → verdicts (5 calls). Self-contained per day.
**Phase B (sequential walk):** synthesis math, **narratives, judges**. Narratives are NOT cosmetic: production overwrites each entry's `invalidationConditions` with the synthesizer's merged list (pipeline.ts merge), which the judge then consumes — so `writeNarratives` (through the cache, with the production fallback path) runs in Phase B immediately after `computeThesisEntries`, before the first judge tick. It lives in Phase B because its input embeds equity-dependent `targetNotionalUsd`.

**Cost estimate (record actuals):** ~124 days × 10 Phase-A calls + narratives on entry days + judges (15-min cadence on days with entries/positions, canonical-cached) ≈ 1,500–3,500 calls, roughly $50–200. Wall clock: Phase A 1–2 h; Phase B minutes of math + judge-call time.

## 4. Execution simulation

`src/backtest/fills.ts` + `src/backtest/ledger.ts`. Deterministic, heavily unit-tested.

**Clock and ticks — production's own gating, not a schedule:** the driver advances 15 minutes at a time through every calendar day (production cadence: launchd every 15 min ≈ 34+ eligible ticks/day). At each step it calls the real `runTick` with `now` = the sim instant; production's `currentSession`/`sessionEnabled` decide eligibility, and production's thesis-load rule (`loadUnexpiredThesis(today) ?? yesterday`, `thesisExpiry`) decides which thesis trades — which automatically exercises D 17:00–20:00, D+1 04:00–09:30, D+1 16:00–17:00 on the prior thesis, and correct Friday/holiday decay with no special cases.

**Quotes (real, not synthesized):** at tick T, the injected marketData returns the latest historical IEX quote with timestamp ≤ T from the T−15min window (bid/ask/sizes as recorded) and the latest trade as `last`. No quote or no trade in the window → the production size/dead-book gates skip the name. Any minute bar consulted at time T must have bar-open ≤ T−60s (bars are timestamped at open; unit test pins this — no future leakage).

**Order lifetime (Alpaca DAY + extended_hours):** an order placed at tick T works until filled or 20:00 ET of its submission day — pre-market orders carry through RTH and after-hours. Fills simulate against SIP minute bars across all sessions the order lives through.

**Fill rule:** BUY qty Q at limit L fills iff a minute bar after placement has `low < L` (strict cross) AND cumulative bar volume from placement to the crossing bar, **within the crossing bar's session**, ≥ 20×Q. Fill price = L. SELL mirrored (`high > L`). No partials (v1). Missing SIP bar = genuinely no prints = no fill.

**Fees (trade-date-keyed, sells only):** TAF $0.000195/share, capped $9.79/trade (whole window); SEC Section 31 $0 through 2026-04-03, $20.60 per $1M notional from 2026-04-06 (FINRA notices cited in report). **Shorts:** hard gate — short entries on symbols not flagged `easy_to_borrow` are rejected with reason `not shortable` (reported like risk-gate rejections); ETB borrow accrual 0.3%/yr as labeled conservatism. All short-side P&L and bear-weight sweep cells are labeled contingent on borrow availability.

**Ledger (`ledger.ts`) implements `BrokerClient`:**
- `getAccount()` → AccountSnapshot from $50k-derived state (equity = cash + marked positions).
- `getDailyPl()` → **per-tick**: marked equity(T) − equity at the most recent 16:00 close (the `last_equity` analogue; positions marked to the quote proxy, carrying the prior mark when no fresh data). This drives the kill-switch mid-session exactly like production (`executor-loop.ts` + `risk.ts` both consume it).
- `getOpenOrders()` / `getTodayOrders()` → orders since ET midnight of the sim calendar day (mirroring `startOfTodayEtIso`), with production `entry-`-prefixed clientOrderIds, so the real `seedDeployedTodayUsd` inherits exact counting rules. Boundary consequence (documented): the deployment budget resets at ET midnight BETWEEN a thesis's after-hours and pre-market sessions, as in production.
- `placeLimitOrder()` → records into the ledger; fills applied by `fills.ts` as sim time advances.

**Halt semantics:** production halts persist until manually cleared (`/api/resume`) — "until manually reset". The backtest models the operator with a flag `halt_policy ∈ {auto-resume (next trading day's first tick), stay-halted (to window end)}`; BOTH run (Phase B is cheap) and the report shows halt dates and the equity delta between policies. Neither is labeled "production semantics" — one is an operator assumption, the other the literal file behavior.

**Assertions:** at each fill, assert the exact `riskCheck` conditions held at placement (position cap, deploy cap at placement-time equity); per-tick aborting invariants only for true invariants: no entries while halted, integer qty ≥ 1, finite positive limit, cash/position accounting consistency. Max exposure and deployment ratios are reported metrics, not aborts.

**End of window:** open positions force-liquidated at the 2026-06-30 20:00 mark for final accounting, clearly labeled; max dangling-position age reported (the v1 no-time-exit gap this backtest is designed to expose).

## 5. Driver

`scripts/backtest.ts` subcommands:
- `fetch` — §1 (idempotent, resumable; includes the feed probe).
- `precompute [--from --to]` — Phase A.
- `run [--config ...] [--halt-policy ...] [--out backtest-out/<tag>]` — Phase B via real `runTick`; artifacts per day (`candidates/verdicts/thesis/ticks/fills/ledger.jsonl`) + `result.json`.
- `sweep` — Phase B only across: `conviction_threshold ∈ {0.45,0.50,0.55,0.60,0.65,0.70}`, bear weight `∈ {0.8,1.2,1.6}`, `max_drop_pct ∈ {2,3,4}`, `max_chase_pct ∈ {1,2}` (~72 cells; `quorum` is NOT swept — it counts verdicts of any direction incl. 'none' and is constant 5/5 with cached verdicts; the report logs the verdict-count distribution to verify). Judge decisions flow through the canonical cache; fresh-call counts reported per cell. Every cell's output includes Jan–Mar AND Apr–Jun performance with per-half trade counts.
- `report <out-dir>` — §6.

## 6. Metrics & report

`src/backtest/metrics.ts` → `backtest-out/<tag>/REPORT.md`.

- **Headline (defaults, untuned, post-cutoff sub-window per §0):** trade-level — n trades, per-trade P&L distribution, total net P&L with a 10k-draw trade-resampling bootstrap 95% CI, win rate with Wilson interval, average/max gross exposure, final equity from $50,000, max drawdown. Sharpe demoted to a footnote (excess of T-bill, annotated `SR ± 1.96·√((1+SR²/2)/n)`, "low power at this n"); Sortino dropped (undefined on a zero-inflated series).
- **Economics — the bar:** net P&L after fees and borrow > (T-bill return on $50k over the window) + (actual LLM spend + projected live operating cost/day × trading days). All three numbers printed.
- **Behavior:** abstention rate (empty-thesis days), trades, fill rate (placed vs filled — the extended-hours realism number), risk-gate rejections by reason (incl. `not shortable`), judge veto rate, halt events under both policies, max dangling-position age, per-analyst verdict distributions.
- **Attribution:** per-trade log with analysts-in-agreement; per-analyst k/n win tables with Wilson 95% intervals; **no weight guidance emitted for any subgroup with n < 30** ("insufficient n — see per-trade log"); bear row computed only over short theses. Weight tuning happens only via sweep + walk-forward.
- **Sensitivity / walk-forward (pre-registered):** selection metric = final equity on the tuning half (post-cutoff days only), tie-break fewer trades then lower drawdown; exactly one cell selected **mechanically in code**; its validation-half P&L reported with a trade-level bootstrap 90% CI and the defaults' rank in the tuning table. If the selected cell has < 30 trades in either half, the sweep is labeled descriptive-only and its deliverable is the abstention-rate and fill-rate vs threshold curves.
- **Validity appendix:** cutoff verification + probe results (with power statement), flagged-day counts, feed choices and the IEX-floor production finding, fill-model assumptions, split exclusions, survivorship & borrow-flag proxies, judge-cache canonicalization, tick-cadence parity note, fee schedule citations, cost actuals.

**"Does it work" = three separate claims:** (1) mechanical — full window, zero invariant violations; (2) behavioral — nonzero but controlled trade rate (if abstention ≈ 100%, the sweep quantifies what loosening costs); (3) economic — the §6 bar above, on defaults. Anything less is reported as "does not work at defaults."

## 7. Tasks

- [ ] **T1** `data.ts` + `backtest-fetch.ts` (universe+borrow flags, dual-feed daily bars, SIP minute bars, quotes/trades windows, news, calendar, corporate actions, benchmarks; resumable). Tests: chunking, pagination, resume, **feed probe** (SIP extended-hours nonzero / IEX zero), raw-adjustment basis fixture with synthetic 10:1 split exclusion.
- [ ] **T2** `scans.ts` (production shapes: 20/20 movers, 30 actives, 50-item news cap, IEX marketInfo). Tests vs hand-built fixtures incl. >50-news truncation.
- [ ] **T3** `llm-cache.ts` (exact + canonical judge cache, token accounting). Tests: hit/miss, canonical-key invariance to sizing fields, corruption → refetch.
- [ ] **T4** `fills.ts` (order lifetime to 20:00, cross rule, per-session volume guard, bar-timestamp discipline, fee schedule both regimes, borrow gate). Tests: cross vs touch, session boundaries, March-vs-May fee fixtures, not-shortable rejection.
- [ ] **T5** `ledger.ts` (BrokerClient impl, per-tick dailyPl, halt policies, ET-midnight order-day boundary, accounting invariants). Tests: kill-switch boundary per-tick, gap-halt blocks D+1 premarket entries, deployment midnight reset, short round-trip with borrow accrual.
- [ ] **T6** `backtest.ts` driver calling real `runTick`/`seedDeployedTodayUsd`/`thesisPath` with OUT_DIR redirection. Integration test: 3 synthetic days, canned caches → deterministic result.json.
- [ ] **T7** `metrics.ts` + REPORT.md generator (bootstrap, Wilson, walk-forward mechanical selection). Tests vs hand-computed series incl. Wilson fixture.
- [ ] **T8** `backtest-probe.ts` (cutoff verification note + masked/unmasked leakage probe with positive controls).
- [ ] **T9** Execute: fetch → probe → precompute → run (defaults, both halt policies) → sweep → report. Review REPORT.md together before believing anything.

Build estimate: T1–T8 one workflow-parallelized session. T9 wall clock: bar download 1–3 h, Phase A 1–2 h, Phase B + sweep < 1 h; LLM spend ~$50–200.

## 8. Out of scope

- Options, intraday-RTH strategies, partial fills, market impact beyond the volume guard.
- Dividend cash flows (raw prices; noted). Splits: exclusion/flagging, not adjustment.
- Extending earlier than the window (pre-cutoff data is uninterpretable for LLM analysts).
