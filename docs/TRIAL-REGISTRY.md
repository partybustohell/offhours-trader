# Trial registry

Append-only log of every strategy variant evaluated against the backtest, so
multiple-testing is explicit. The **honest count of rows here is the `nTrials`**
fed to `deflatedSharpe` — every threshold sweep, weight change, signal toggle,
or gate re-calibration inflates the best observed Sharpe by selection and must
be logged before its result is quoted.

Rules:

- Log a row **before** reading the result, not after. Post-hoc registration
  defeats the purpose.
- A "trial" is any change that could change the economic outcome: conviction
  threshold, agent weights, quorum/min_agreeing, any `signals.*` toggle, gate
  thresholds (spread, cost, blackout windows), sizing mode, regime params.
- Pure guardrails that cannot change the *direction* of a trade (min-position
  floor, max-open-names, timing blackout, exposure caps) still change results
  and so are logged, but flag them `guardrail` — they are not alpha searches.
- No economic PASS/FAIL verdict is emitted below
  `min_trades_for_economic_claim` (config, default 50); the report enforces
  this. The deflated Sharpe uses the count of `alpha`-type rows.

| # | date | tag | change | type (alpha/guardrail) | result (registered before reading?) | notes |
|---|------|-----|--------|------------------------|--------------------------------------|-------|
| 1 | 2026-01 | rev2-sweep | conviction_threshold sweep → 0.55 shipped | alpha | yes | Jan–Jun 2026 window; no positive edge established at any threshold (see config.yaml note) |
| 2 | 2026-07-09 | quant-p0 | P0 guardrails: deploy_priority, min-position floor, max-open-names, timing blackout, gross/net caps | guardrail | n/a (not an alpha search) | safe-by-construction; enabled by default |
| 3 | 2026-07-09 | quant-p1-p3 | P1–P3 machinery built flag-OFF: anti_chase, amihud, dispersion, trend_gate, gap, low_vol, regime (trend/vol/gross), portfolio (target_vol/inverse_vol/cov), cost_scalar, participation, entry_aggressiveness, gates_by_session, drawdown_throttle, risk_off, calibration | alpha (deferred) | not evaluated — all disabled | NO backtest search run yet. Each is a pre-registered rule shipping inert. Enabling ANY = a new alpha trial that MUST be logged here first, and no economic claim below min_trades_for_economic_claim (≥50 OOS trades). Enable one-at-a-time; recalibrate conviction_threshold after any score-affecting change. |
