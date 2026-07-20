# Trial registry

Append-only log of every strategy variant evaluated against the backtest, so
multiple-testing is explicit. The machine-readable source of truth is
`trial-registry.yaml`; this file is the narrative log. The **`nTrials`** fed to
`deflatedSharpe` is the **sum of the `cells` field over `type: alpha` rows**
(a row without `cells` counts as 1) — every threshold sweep, weight change,
signal toggle, or gate re-calibration inflates the best observed Sharpe by
selection and must be logged before its result is read.

Field semantics (yaml):

- `date` — **registration date**: when the row was written. Not the run date,
  not the data window.
- `window` — the data window evaluated, e.g. `2026-01-01..2026-07-01`.
- `cells` — evaluated config cells the row covers. Counting granularity is
  **per cell, recorded as campaign rows**: one row per sweep/campaign, with
  `cells` = the number of priced config evaluations it covers. Every priced
  evaluation counts, including re-runs of the same cell under changed
  harness/gate settings and runs later judged invalid — over-counting only
  raises the DSR benchmark (conservative); under-counting is the failure mode.
  Budget-only/count-only passes price nothing and do not count.
- `flags` — additional flags a campaign row covers. This registers **backtest
  search only**. Enabling a signal **live** requires a dedicated row whose
  `flag` is that signal's config path — the preflight gate matches `flag`
  exactly and ignores `flags` lists.
- `mechanism` — the hypothesis's economic mechanism, stated **before** the row
  can authorize new work. Three sentences (each ≥ 5 words — a sentence floor
  to reject placeholders, not a quality grade):
  - `counterparty` — who is on the other side of the trade;
  - `whyTheyPay` — why they systematically lose or pay;
  - `friction` — what stops professionals from closing it.
  If those three sentences cannot be written down, the idea is
  parameter-fishing and the registry would only record another kill. Legacy
  rows without a mechanism keep counting toward `nTrials` (history is
  history) but **no longer authorize** new sweeps or live enables.

Rules:

- Log a row **before** reading the result, not after. Post-hoc registration
  defeats the purpose; where it happens anyway (to keep the count honest),
  mark the row `REGISTERED POST-HOC`.
- A "trial" is any change that could change the economic outcome: conviction
  threshold, agent weights, quorum/min_agreeing, any `signals.*` toggle, gate
  thresholds (spread, cost, blackout windows), sizing mode, regime params,
  quote feed.
- Pure guardrails that cannot change the *direction* of a trade (min-position
  floor, max-open-names, timing blackout, exposure caps) still change results
  and so are logged, but flag them `guardrail` — they are not alpha searches.
- No economic PASS/FAIL verdict is emitted below
  `min_trades_for_economic_claim` (config, default 50); the report enforces
  this. The deflated Sharpe uses the summed cell count of `alpha`-type rows.
- **Enforcement**: `pnpm preflight` blocks an enabled live alpha flag with no
  exact-`flag` alpha row, and blocks one whose row(s) lack a `mechanism`
  statement; `backtest.ts sweep` refuses to run a search whose flags have no
  alpha coverage (`flag` or `flags`), and refuses one whose coverage is
  entirely mechanism-less. A new campaign over already-registered flags still
  requires appending a row (or bumping `cells`) before results are read — and
  that new row must carry the mechanism.

| # | date (registered) | window | tag | change | type | cells | result (registered before reading?) | notes |
|---|------|--------|-----|--------|------|-------|--------------------------------------|-------|
| 1 | 2026-07-09 | 2026-01-01..2026-07-01 | rev2-sweep | conviction_threshold × bear-weight search → 0.55 shipped | alpha | 33 | yes | 18-cell rev1 grid (6 thr × 3 bear) + 15-cell rev2 5×3 replay; no positive edge at any threshold. Date was previously logged as "2026-01" — that was the window start, not the registration date; corrected 2026-07-10. |
| 2 | 2026-07-09 | — | quant-p0 | P0 guardrails: deploy_priority, min-position floor, max-open-names, timing blackout, gross/net caps | guardrail | — | n/a (not an alpha search) | safe-by-construction; enabled by default |
| 3 | 2026-07-09 | — | quant-p1-p3 | P1–P3 machinery built flag-OFF: anti_chase, amihud, dispersion, trend_gate, gap, low_vol, regime (trend/vol/gross), portfolio (target_vol/inverse_vol/cov), cost_scalar, participation, entry_aggressiveness, gates_by_session, drawdown_throttle, risk_off, calibration | guardrail | — | n/a (machinery, not a search) | Signals inert in the LIVE config. Backtest signal-toggle sweeps HAVE since run against these flags (rows 4–5) — the original "no backtest search run yet" note was falsified 2026-07-09. Enabling any signal live = a new alpha row for its specific flag first; no economic claim below min_trades_for_economic_claim (≥50 OOS trades); enable one-at-a-time; recalibrate conviction_threshold after any score-affecting change. |
| 4 | 2026-07-10 | 2026-01-01..2026-07-01 | sig1–sig6 | signal-toggle sweeps: baseline + one-signal-on cells (13 flags), thr 0.55 / bear 1.2 | alpha | 59 | **no — registered post-hoc** (runs 2026-07-09) | Broken-harness runs (IEX quote-blind until d1b5196, entry blackout on, aborted episodes). Priced cells: sig1 14, sig2 3, sig3 14, sig4 14, sig5 14, sig6 0 (budget pass only). Results are NOT valid evidence for any signal, but the cells were evaluated and count as trials. |
| 5 | 2026-07-10 | 2026-01-01..2026-07-01 | sig7 | signal-toggle sweep on SIP, no-blackout: baseline + 13 one-signal cells | alpha | 14 | **no — registered post-hoc** (run 2026-07-09) | Baseline completed 41 episodes vs 50 in signal cells — sweep-results.json compares unpaired totals, and failures censor exactly the would-trade days, so per-signal differences are a missing-episode artifact. No keep/kill verdict until re-run with paired episode sets. |
| 6 | 2026-07-10 | 2026-01-01..2026-07-01 | v2-sip, v3-sip, v3b-sip, v3c-guard | headline replays of the shipped config under feed/guard variants | alpha | 4 | **no — registered post-hoc** (runs 2026-07-09) | Each a distinct evaluated cell on the same window. |
| 7 | 2026-07-10 | — | earnings-underreaction-smallcap | pre-register `signals.event_reaction` hypothesis with mechanism statement | alpha | 1 | **yes — design stage, nothing evaluated** | First mechanism-bearing row. Counterparty: small-cap post-earnings profit-takers + scheduled index/ETF flows; why they pay: anchoring → post-earnings-announcement drift; friction: below institutional capacity, thin coverage. Predicted locus (pre-registered subgroup): small, thinly covered names — a large-cap-concentrated effect falsifies the friction sentence even at positive P&L. horizonDays 180, targetActiveN 50; machinery not built yet, enabledDate set when it lands. |
| 8 | 2026-07-15 | 2026-01-01..2026-07-01 | exit-engine-v1 | deterministic exit engine (hard stop / invalidation price / target / trail / time-stop), tick-enforced + native RTH stop leg; paired on/off cell | guardrail | — | yes — pre-registered 2026-07-15, run 2026-07-20 | COMPLETE. Run 1 (tag exit-engine-v1) defective: runner dropped LLM exit levels (fixed ea27518) — exact zero pair, kept as no-regression floor. Run 2 (tag exit-engine-v1b): 50/50 shared episodes, 7 trades/cell, 1/50 days differ; force-flatten truncation 42.9%→28.6%; maxDD $106.58→$104.49; book vol $10.04→$11.22; paired net diff R exactly 0 (CI [0,0]), design-weighted +$0.31/ep — below the economic-claim floor, nothing disproved. No risk-shape regression; weak favorable truncation signal; guardrail evidence path stays the live paper soak (5h episodes cannot reach multi-day time stops). |
