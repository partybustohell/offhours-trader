# Off-Hours Trader

Multi-agent stock trading system. Five analyst agents with different purviews
(fundamental, technical, macro, sentiment, and an adversarial bear) discover
their own candidate tickers from market scans, render structured verdicts, and
a synthesizer merges them into a cohesive daily thesis. A separate executor
agent trades that thesis during US extended hours only (pre-market 4:00–9:30 AM
ET, after-hours 4:00–8:00 PM ET) through Alpaca, behind a deterministic risk
gate. A React dashboard shows every layer and edits the config.

**It trades a demo (paper) account by default.** Live trading requires three
deliberate steps (below) and is never enabled implicitly.

## Setup

```bash
pnpm install
cp .env.example .env   # then fill in keys
pnpm build:frontend    # builds the dashboard into frontend/dist
```

Keys needed in `.env`:

- `ANTHROPIC_API_KEY` — for the analyst/synthesizer/executor agents
- `ALPACA_PAPER_KEY` / `ALPACA_PAPER_SECRET` — free paper account from
  https://app.alpaca.markets (also serves market data in all modes)

## Running

```bash
pnpm pipeline   # evening pipeline: discover -> verdicts -> thesis (run after close, e.g. 5pm ET)
pnpm tick       # one executor tick (no-op outside enabled extended-hours sessions)
pnpm serve      # dashboard + API on http://localhost:4310
pnpm test       # unit + replay integration tests
pnpm seed       # write demo data into out/ so the dashboard renders without keys
                # (the seeded thesis is pre-expired so the executor can never
                #  act on it, and seeding never touches the halt state)
```

The system is file-driven: the pipeline writes `out/candidates-*.json`,
`out/verdicts-*.json`, `out/thesis-*.json`; the executor reads the thesis and
appends every decision to `out/audit-*.jsonl`. The dashboard reads the same
files. Delete `out/` and nothing else breaks.

## Modes

| mode      | orders placed | broker keys used            |
|-----------|---------------|-----------------------------|
| `dry-run` | none (logged) | paper (reads only)          |
| `paper`   | paper account | `ALPACA_PAPER_*`            |
| `live`    | real money    | `ALPACA_LIVE_*`             |

### Connecting a real account later

All three are required, or the system refuses to start (it never silently
falls back to paper):

1. Put `ALPACA_LIVE_KEY` / `ALPACA_LIVE_SECRET` in `.env` (separate slots —
   paper keys are never used for live and vice versa).
2. Set `mode: live` in `config.yaml` by hand.
3. Set `live_trading_acknowledged: true` in `config.yaml` by hand.

The dashboard cannot make either config change; `PUT /api/config` pins `mode`
and `live_trading_acknowledged` to their on-disk values.

## Tuning

Everything lives in `config.yaml` and is editable from the dashboard's config
panel (except the two live-mode fields): universe filters and exclude list,
per-agent weights, conviction threshold, quorum, position/deployment/notional
caps, spread tolerance, limit-band chase/drop percentages, daily-loss halt,
session toggles, executor interval, and per-role model choice. Changes take
effect on the next pipeline run or executor tick.

## Scheduling (macOS)

Two launchd jobs (or cron equivalents): the pipeline once per weekday evening,
the executor every 15 minutes (it exits immediately outside enabled sessions).

`~/Library/LaunchAgents/com.offhours.pipeline.plist` — daily 17:05 ET:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.offhours.pipeline</string>
  <key>WorkingDirectory</key><string>/Users/shivbrahmbhatt/offhours-trader</string>
  <key>ProgramArguments</key>
  <array><string>/usr/local/bin/pnpm</string><string>pipeline</string></array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>17</integer><key>Minute</key><integer>5</integer></dict>
  <key>StandardOutPath</key><string>/tmp/offhours-pipeline.log</string>
  <key>StandardErrorPath</key><string>/tmp/offhours-pipeline.log</string>
</dict></plist>
```

`~/Library/LaunchAgents/com.offhours.tick.plist` — every 15 minutes:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.offhours.tick</string>
  <key>WorkingDirectory</key><string>/Users/shivbrahmbhatt/offhours-trader</string>
  <key>ProgramArguments</key>
  <array><string>/usr/local/bin/pnpm</string><string>tick</string></array>
  <key>StartInterval</key><integer>900</integer>
  <key>StandardOutPath</key><string>/tmp/offhours-tick.log</string>
  <key>StandardErrorPath</key><string>/tmp/offhours-tick.log</string>
</dict></plist>
```

Load with `launchctl load ~/Library/LaunchAgents/com.offhours.*.plist`.
Note: launchd `StartCalendarInterval` fires in the Mac's local timezone —
adjust the hour if you are not in ET. (`launchctl` hour above assumes ET;
for PT use 14.)

## Known v1 limitations

- Market holidays are treated as normal weekdays; Alpaca rejects those orders
  and the executor just logs it.
- Stop orders do not execute during extended hours at any broker, so the
  executor monitors thesis invalidation conditions itself and exits with limit
  orders. Between ticks (default 15 min) there is no protection.
- Extended-hours liquidity is thin and spreads are wide. The spread gate
  (`max_spread_bps`) skips bad quotes, but paper fills are optimistic compared
  to real extended-hours fills — treat paper results as an upper bound.
- The dashboard has no auth. It binds to localhost; do not expose it.

## Architecture

```
[evening]  scans -> 5 analysts nominate -> filter/cap -> 5 analysts verdict
           -> deterministic synthesis (weights, quorum, disagreement, threshold)
           -> LLM narrative -> out/thesis-YYYY-MM-DD.json

[off hours] thesis + live quotes -> code gates (band/spread/size)
           -> executor judge (invalidation check, veto only)
           -> deterministic risk gate -> Alpaca (paper|live) -> audit log
```

LLMs nominate, argue, narrate, and veto. Position sizing, conviction math,
bands, caps, halts, and order construction are plain code with unit tests.
