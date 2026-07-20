# Go-Live Runbook

How to take the off-hours trader from a built system to running against the
market. Follow the stages in order; each gate must pass before the next.

## The one prerequisite that decides everything: the data feed

The executor reads quotes from Alpaca. The **free IEX feed only trades
08:00–17:00 ET**, but the strategy's sessions are pre-market (04:00–09:30) and
after-hours (16:00–20:00). They overlap only from **08:00–09:30 and
16:00–17:00**. During the deep off-hours the system was built for —
**04:00–08:00 and 17:00–20:00** — IEX has no live quotes, and the staleness
guard (correctly) makes the executor abstain.

Consequence: **on the free feed the system does almost nothing.** It can trade
only the two RTH-adjacent slivers, so even a paper soak accumulates trades too
slowly to answer the edge question. Real off-hours operation requires:

- **Alpaca real-time SIP data** (the "Algo Trader Plus" subscription, ~$99/mo),
  then set `data_feed: sip` in `config.yaml`.

This is on the critical path for both live money *and* a meaningful paper soak.
Everything below works on the free feed, but understand you are testing the
plumbing, not the strategy, until SIP is on.

## Regular-hours (RTH) trading — works on the free feed

The system can also trade the regular session (09:30–16:00 ET). This is a
distinct product from off-hours and, crucially, **it works on the free IEX
feed** — IEX has live quotes 09:30–16:00, so no SIP subscription is needed to
trade or soak during regular hours.

Enable it in `config.yaml`: `sessions.regularhours: true`. Then:

- A **morning pipeline** (`pnpm pipeline rth`, scheduled 09:00 ET) builds a
  fresh RTH thesis from overnight/pre-market news and the prior close, written
  to `out/thesis-<date>-rth.json` and expiring at that day's 16:00 close.
- The executor trades it during 09:30–16:00 with `extended_hours=false`.
- Each RTH entry carries a **native Alpaca stop-loss** (OTO order) at
  `max_position_loss_pct` — real, continuous protection between ticks, which
  extended-hours orders cannot have.

The off-hours evening thesis and the RTH morning thesis coexist (different
files); the executor picks the right one for the current session automatically.

## Modes (config.yaml `mode`)

Progress through these in order; do not skip.

| mode | orders | use for |
|---|---|---|
| `dry-run` | logged only, never sent | first wiring test |
| `paper` | sent to the Alpaca **paper** account (simulated fills) | the soak — default |
| `live` | **real money** | only after a successful soak + deliberate opt-in |

Live requires all three, or the system refuses to start: `mode: live`,
`live_trading_acknowledged: true`, and `ALPACA_LIVE_KEY`/`ALPACA_LIVE_SECRET`
in `.env`. None of this can be changed from the dashboard.

## Stage 1 — one-time setup

```bash
pnpm install
pnpm build:frontend
# .env must contain ANTHROPIC_API_KEY and ALPACA_PAPER_KEY / ALPACA_PAPER_SECRET
pnpm test            # 297 tests must pass
pnpm preflight       # must print READY (0 blockers)
```

## Stage 2 — prove the path (dry-run)

```bash
# set mode: dry-run in config.yaml
pnpm pipeline        # discovers candidates, writes out/thesis-<date>.json
pnpm tick            # evaluates the thesis; logs orders, sends nothing
pnpm serve           # dashboard at http://localhost:4310 — inspect thesis, audit
```

Confirm in the audit feed: the pipeline produced a thesis, and ticks either
placed dry-run orders or skipped with a reason (`no thesis`, `stale_quotes`,
`session closed`, `below threshold`). No real orders exist.

## Stage 3 — paper soak

```bash
# set mode: paper in config.yaml
bash scripts/install-schedule.sh   # writes launchd jobs, UNLOADED
launchctl load ~/Library/LaunchAgents/com.offhours.pipeline.plist
launchctl load ~/Library/LaunchAgents/com.offhours.tick.plist
```

Now the pipeline runs each weekday at 17:05 and the executor ticks every 15
minutes. Watch the dashboard daily. Let it run for **weeks**, not days — the
backtest showed abstention dominates, so a real trade sample takes time
(faster once `data_feed: sip` is on). Track: trades, fill rate, risk-gate
rejections, halts, and P&L vs the $100k paper baseline.

Stop the jobs anytime:
```bash
launchctl unload ~/Library/LaunchAgents/com.offhours.*.plist
```

## Stage 4 — live (only after a convincing soak)

Do NOT do this until the paper soak shows the system behaves as intended over a
real trade sample with SIP data. Then, by hand:

1. Add `ALPACA_LIVE_KEY` / `ALPACA_LIVE_SECRET` to `.env` (separate slots).
2. Set `mode: live` and `live_trading_acknowledged: true` in `config.yaml`.
3. `pnpm preflight` — must print READY and show the LIVE warning.
4. Start with tiny caps: lower `max_order_notional_usd` and `max_position_pct`
   for the first live sessions.
5. Reload the launchd jobs.

## Daily operation & safety

- **Dashboard** (`pnpm serve`, :4310): mode, session, halt state, equity,
  thesis, positions, orders, risk-gate rejections, and the audit feed.
- **Kill switch:** the `daily_loss_halt_pct` trip halts all trading until
  manually reset; you can also POST `/api/halt` (or use the dashboard) any time.
  A halt persists until you resume.
- **Between-tick gap risk:** there is no stop protection while the market is
  closed (17:00-next 04:00). Volatility-targeted sizing limits the damage; do
  not raise `max_position_pct` to compensate.
- **Every decision is audited** to `out/audit-<date>.jsonl`. When something
  looks wrong, that file is the record of exactly what happened and why.

## Macro-event calendar refresh (monthly)

`config.yaml -> macro_event_blackout.events` is a static ET calendar. On the
first weekday of each month, refresh it from the primary sources so every
CPI/FOMC/payrolls release through at least the next 60 days is listed:

- CPI: https://www.bls.gov/schedule/news_release/cpi.htm (08:30 ET)
- Employment situation: https://www.bls.gov/schedule/news_release/empsit.htm (08:30 ET)
- FOMC statements: https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm (14:00 ET, final meeting day)

An empty or stale calendar simply provides no gate on unlisted dates — the
executor logs `event_blackout` skips only for dates that are present.
