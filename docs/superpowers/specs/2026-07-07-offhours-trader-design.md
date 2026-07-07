# Off-Hours Trader — Design Spec

Date: 2026-07-07
Status: Draft, pending user review

## Purpose

A multi-agent stock trading system. There is no user watchlist: the system
discovers its own candidates. A panel of analyst sub-agents with distinct
viewpoints first nominates tickers from purview-matched market scans, then
produces structured verdicts on the combined candidate set. A synthesizer merges
verdicts into a cohesive thesis. A separate executor agent trades against that
thesis during US extended-hours sessions (pre-market 4:00–9:30 AM ET,
after-hours 4:00–8:00 PM ET). All behavior is tunable through a single config file.

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

- TypeScript, Node 22+, pnpm, ESM
- `@anthropic-ai/sdk` for agent calls. Analysts do not need autonomous tool loops
  in v1: code fetches their data (bars, news, fundamentals) and hands it to them;
  forced tool-use gives structured verdicts. Agent SDK is a future option.
- Alpaca REST API: trading (paper/live) + market data (IEX feed) + news
- Express API server + React 19/Vite frontend (dashboard)
- Scheduling: launchd (macOS) or cron; each entry point is also runnable manually
- Vitest for tests

## Architecture

Two decoupled stages connected by an artifact file.

```
[Evening pipeline — daily ~5:00 PM ET]
  market scans ──► Round 1: 5 analysts nominate candidates (parallel)
               ──► code: dedupe + liquidity filter + cap ──► candidate set
               ──► Round 2: 5 analysts render verdicts on all candidates (parallel)
               ──► synthesizer ──► out/thesis-YYYY-MM-DD.json

[Executor loop — every N min, only inside enabled extended-hours windows]
  thesis.json + live quotes ──► executor agent ──► risk gate (plain code) ──► BrokerClient ──► Alpaca
```

The pipeline never places orders. The executor never does research. The thesis
file is the only contract between them.

## Components

### 0. Candidate discovery (Round 1)

No user watchlist. Code fetches purview-matched scans from Alpaca market data —
top movers (gainers/losers), most-actives by volume, and the news feed — plus
daily bars for context. Each analyst receives the scans relevant to its purview
and nominates up to `nominations_per_agent` (default 5) tickers, each with a
one-line reason: `{ticker, reason}`.

Code then builds the candidate set deterministically:
- union of nominations, deduped (nomination count retained as a signal)
- liquidity filter: last price ≥ `min_price`, 20-day avg dollar volume ≥
  `min_avg_dollar_volume`
- drop anything on the user's `exclude` list
- cap at `max_candidates` (default 15), ranked by nomination count, then avg
  dollar volume

Candidates and their nominators/reasons are written to
`out/candidates-YYYY-MM-DD.json` for the audit trail and frontend.

### 1. Analyst sub-agents (Round 2)

Five parallel agents, same candidate set, distinct system prompts and data purviews:

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
universe:
  nominations_per_agent: 5
  max_candidates: 15
  min_price: 5
  min_avg_dollar_volume: 20000000
  exclude: []            # tickers the system must never trade
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

### 6. Frontend (basic dashboard)

React 19 + Vite + TypeScript single-page app, served by an Express API server
(`src/server.ts`) that also exposes the system's state. Read-mostly; the one
write surface is config editing.

Views:
- **Status bar:** mode badge (DRY-RUN / PAPER / LIVE), current session
  (pre-market / RTH / after-hours / closed), kill-switch state, account equity.
- **Candidates panel:** today's discovered candidates — who nominated each
  ticker and why, which survived the liquidity filter/cap.
- **Thesis panel:** current thesis per ticker — direction, weighted conviction,
  limit band, narrative, invalidation conditions, expiry.
- **Verdicts panel:** per-analyst verdicts behind each thesis (the "why").
- **Positions & orders:** open positions, working/filled/rejected orders with
  risk-gate rejection reasons.
- **Audit feed:** tail of today's audit JSONL, newest first.
- **Config editor:** form bound to `config.yaml` fields (weights, thresholds,
  caps, sessions, universe filters, exclude list, interval). Validated
  server-side with the same schema the system uses. `mode` and
  `live_trading_acknowledged` are displayed but NOT editable from the UI —
  switching to live requires editing the file by hand. Config changes take
  effect on the next pipeline run / executor tick.
- **Actions:** "Run pipeline now", "Executor tick now", "Halt" / "Resume"
  (kill switch). Halt/Resume writes a state file the executor checks.

API (Express, port 4310):
- `GET /api/status`, `GET /api/candidates`, `GET /api/thesis`, `GET /api/verdicts`,
  `GET /api/positions`, `GET /api/orders`, `GET /api/audit?limit=N`
- `GET /api/config`, `PUT /api/config` (schema-validated; mode/ack immutable via API)
- `POST /api/pipeline/run`, `POST /api/executor/tick`, `POST /api/halt`, `POST /api/resume`

The server never holds trading logic; it shells out to the same entry points the
scheduler uses and reads the same files (`out/thesis-*.json`, audit logs, state).

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
- Auth on the dashboard (localhost only), websockets/live push (poll instead)
