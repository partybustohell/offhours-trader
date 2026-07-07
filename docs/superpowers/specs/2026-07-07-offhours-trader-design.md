# Off-Hours Trader — Design Spec

Date: 2026-07-07
Status: Draft, pending user review

## Purpose

A multi-agent stock trading system. A panel of analyst sub-agents with distinct
viewpoints produces structured verdicts on a watchlist. A synthesizer merges them
into a cohesive thesis. A separate executor agent trades against that thesis during
US extended-hours sessions (pre-market 4:00–9:30 AM ET, after-hours 4:00–8:00 PM ET).
All behavior is tunable through a single config file.

## Non-negotiable requirements

1. **Demo account by default.** The system ships pointed at an Alpaca paper
   account. All development, testing, and initial operation happen there.
2. **Real account is a later connection, not a rewrite.** The broker layer is one
   interface (`BrokerClient`) with paper and live as configurations of the same
   Alpaca client (different base URL + keys). Switching to live requires ALL of:
   - `mode: live` in `config.yaml`
   - live API credentials present in `.env` (`ALPACA_LIVE_KEY` / `ALPACA_LIVE_SECRET`),
     stored separately from paper credentials
   - `live_trading_acknowledged: true` in `config.yaml`
   If any is missing, the system refuses to start in live mode and falls back to
   refusing (not silently downgrading to paper).
3. **Risk gate is deterministic code.** No LLM output can bypass it.
4. **Default posture is "do nothing."** Every ambiguity, error, quorum failure, or
   threshold miss resolves to no trade.

## Stack

- TypeScript, Node 22+, pnpm
- Claude Agent SDK for agent orchestration (analysts, synthesizer, executor)
- Alpaca REST API: trading (paper/live) + market data (IEX feed) + news
- Scheduling: launchd (macOS) or cron; each entry point is also runnable manually
- Vitest for tests

## Architecture

Two decoupled stages connected by an artifact file.

```
[Evening pipeline — daily ~5:00 PM ET]
  watchlist ──► 5 analyst sub-agents (parallel) ──► synthesizer ──► out/thesis-YYYY-MM-DD.json

[Executor loop — every N min, only inside enabled extended-hours windows]
  thesis.json + live quotes ──► executor agent ──► risk gate (plain code) ──► BrokerClient ──► Alpaca
```

The pipeline never places orders. The executor never does research. The thesis
file is the only contract between them.

## Components

### 1. Analyst sub-agents

Five parallel agents, same watchlist, distinct system prompts and data purviews:

| Agent       | Purview |
|-------------|---------|
| Fundamental | Valuation, earnings history, filings |
| Technical   | Price action, momentum, support/resistance from daily bars |
| Macro       | Rates, sector rotation, macro calendar |
| Sentiment   | Headlines, post-close earnings releases (Alpaca news API) |
| Bear        | Adversarial by mandate: argues against every candidate |

Each returns structured output only:

```json
{
  "ticker": "NVDA",
  "direction": "long | short | none",
  "conviction": 0.0,
  "horizon": "days | weeks",
  "evidence": ["..."],
  "invalidation_conditions": ["..."]
}
```

An analyst that errors or times out is dropped for the run.

### 2. Thesis synthesizer

Inputs: all verdicts + config. Output: `thesis.json`.

- Weighted conviction = Σ(agent conviction × configured agent weight), normalized.
- **Quorum:** fewer than `quorum` (default 3 of 5) verdicts on a ticker → no thesis.
- **Threshold:** weighted conviction below `conviction_threshold` → no thesis.
- **Disagreement guard:** if opposing directions each carry normalized weighted
  conviction ≥ 0.3, no thesis for that ticker.
- Per surviving candidate, the thesis records: direction, weighted conviction,
  limit price band, position size (from config caps), explicit invalidation
  conditions, and expiry (a thesis is valid for one trading day unless renewed).

### 3. Executor agent

Runs on an interval (default 15 min) only inside enabled sessions. Per tick:

1. Load the current unexpired thesis; exit if none.
2. Fetch live quotes for thesis tickers.
3. Entry check: last price inside limit band, bid-ask spread ≤ `max_spread_bps`,
   minimum quote size present.
4. Invalidation check on open positions: extended-hours stop orders do not
   trigger at the broker, so the executor monitors invalidation conditions itself
   and exits via limit order.
5. Propose orders → risk gate.

All extended-hours orders are limit + DAY with Alpaca's `extended_hours: true`.
Market orders are never constructed anywhere in the codebase.

### 4. Risk gate (deterministic, no LLM)

Hard checks on every proposed order:

- mode check (dry-run logs only; paper/live route to the matching credentials)
- limit orders only
- max position size (% of portfolio)
- max daily deployment (% of portfolio)
- max single-order notional
- duplicate/overlapping order dedupe
- daily-loss kill switch: realized+unrealized loss past threshold halts all
  trading until manually reset

Any failure → order rejected and logged with reason.

### 5. Config (`config.yaml`)

```yaml
mode: paper                  # dry-run | paper | live
live_trading_acknowledged: false
watchlist: [AAPL, NVDA, MSFT]
sessions: {premarket: true, afterhours: true}
agent_weights: {fundamental: 1.0, technical: 0.8, macro: 0.6, sentiment: 1.0, bear: 1.2}
conviction_threshold: 0.65
quorum: 3
max_position_pct: 5
max_daily_deploy_pct: 10
max_order_notional_usd: 2000
max_spread_bps: 50
daily_loss_halt_pct: 3
executor_interval_min: 15
thesis_run_time_et: "17:00"
model:
  analysts: claude-sonnet-5
  synthesizer: claude-fable-5
  executor: claude-sonnet-5
```

Credentials live in `.env` (gitignored): `ALPACA_PAPER_KEY`, `ALPACA_PAPER_SECRET`,
and later `ALPACA_LIVE_KEY`, `ALPACA_LIVE_SECRET`. Paper and live keys are never
interchangeable slots.

## Error handling

- Analyst failure → dropped; quorum absorbs up to 2 failures.
- Broker/data API failure → retry twice with backoff, then abstain until next tick.
- Malformed thesis file → executor refuses to trade and logs.
- Every verdict, thesis, proposed order, placed order, and rejection is appended
  to `out/audit-YYYY-MM-DD.jsonl`.

## Testing

- Unit tests: risk gate (every rule, boundary values), order construction,
  config validation, live-mode triple-check refusal paths.
- Replay mode: feed a recorded day's quotes/news through the full pipeline
  against the paper API.
- Acceptance: multi-week paper soak before live connection is considered.

## Out of scope (v1)

- Options, crypto, non-US equities
- Intraday regular-hours trading
- Backtesting framework beyond replay mode
- Portfolio optimization across theses
- Any UI; config file + audit log only
