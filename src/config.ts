import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';

export const ConfigSchema = z.object({
  mode: z.enum(['dry-run', 'paper', 'live']).default('paper'),
  live_trading_acknowledged: z.boolean().default(false),
  universe: z
    .object({
      nominations_per_agent: z.number().int().min(1).max(10).default(5),
      max_candidates: z.number().int().min(1).max(50).default(15),
      // Verdict-round chunking: at most this many candidates per LLM call, so
      // the per-candidate output budget (~900 tokens each) always fits without
      // hitting the response cap. 8 * 900 = 7.2k tokens per call — the
      // truncation class behind the 2026-07-27 quorum collapse is structurally
      // unreachable at the default. Raising it toward max_candidates restores
      // the old single-call behavior (and its saturation risk).
      verdict_chunk_size: z.number().int().min(1).max(50).default(8),
      min_price: z.number().positive().default(5),
      min_avg_dollar_volume: z.number().positive().default(20_000_000),
      exclude: z.array(z.string()).default([]),
      // Catalyst-first candidate sourcing: feed the scheduled earnings calendar
      // (today's post-close + tomorrow's pre-open reporters) into the analyst
      // scans, so the panel can evaluate names BEFORE the reaction instead of
      // only after they show up on the movers list (adverse selection at the
      // source). Fail-open: a calendar fetch failure yields an empty scan and
      // is audited; nothing blocks. Registered alpha flag (trial-registry.yaml
      // earnings-scan-2026-07-27; mechanism shared with
      // earnings-underreaction-smallcap). Default OFF for backtest parity.
      earnings_scan: z.object({ enabled: z.boolean().default(false) }).default({}),
      // Pass the news article BODY (HTML-stripped, truncated) to the verdict
      // round, not just headline+summary — reading guidance language in the
      // primary text is the one capability an LLM panel has over keyword
      // scanners. Information upgrade only; no parameters to fit. Changes the
      // verdict prompt bytes, so backtest LLM caches re-run when enabled.
      news_content: z
        .object({
          enabled: z.boolean().default(false),
          max_chars: z.number().int().min(200).max(10_000).default(1500),
        })
        .default({}),
      // SEC EDGAR primary text (registry row edgar-content-2026-07-28): feed
      // the verdict round each candidate's recent 8-K / press-release exhibit
      // — the PRIMARY document, not a vendor paraphrase. Same family as
      // news_content (information provision; the panel still decides; no
      // parameters to fit) but sourced from the filing itself. Fail-open per
      // ticker; sequential fetches respect SEC fair-access limits. Default
      // OFF: changes verdict prompt bytes (backtest LLM caches re-run) and
      // ships behind its registry row.
      edgar_content: z
        .object({
          enabled: z.boolean().default(false),
          lookback_days: z.number().int().min(0).max(10).default(2),
          max_chars: z.number().int().min(500).max(20_000).default(4000),
        })
        .default({}),
    })
    .default({}),
  sessions: z
    .object({
      premarket: z.boolean().default(true),
      afterhours: z.boolean().default(true),
      // Regular session 09:30-16:00 ET. Off by default: it's a distinct product
      // (full liquidity, fresh morning thesis) and works on the free IEX feed.
      regularhours: z.boolean().default(false),
    })
    .default({}),
  agent_weights: z
    .object({
      fundamental: z.number().min(0).default(1.0),
      technical: z.number().min(0).default(0.8),
      macro: z.number().min(0).default(0.6),
      sentiment: z.number().min(0).default(1.0),
      bear: z.number().min(0).default(1.2),
    })
    .default({}),
  conviction_threshold: z.number().min(0).max(1).default(0.65),
  quorum: z.number().int().min(1).max(5).default(3),
  min_agreeing: z.number().int().min(1).max(5).default(2),
  max_position_pct: z.number().positive().default(5),
  max_daily_deploy_pct: z.number().positive().default(10),
  // Order in which thesis entries are funded when the daily-deploy cap binds
  // in the executor. 'conviction' funds the highest-conviction names first;
  // 'conviction_per_risk' divides conviction by the name's realized vol so a
  // fixed vol budget buys the best risk-adjusted names first. Deterministic
  // tie-break by ticker. (The executor consumes thesis.entries in array order.)
  deploy_priority: z.enum(['conviction', 'conviction_per_risk']).default('conviction'),
  // A funded position must clear this dollar floor, else it is dropped in
  // synthesis. Below it, whole-share rounding turns the target into 1-share
  // dust and quantization error dominates the intended sizing. NOTE: sizing
  // base = min(max_order_notional_usd, equity*max_position_pct); at small
  // equity (< ~$5k) base*conviction can fall below this floor and SILENTLY
  // drop marginal entries — lower this proportionally for small accounts.
  min_position_notional_usd: z.number().min(0).default(250),
  // Cap on the number of entries a single thesis emits, applied AFTER the
  // conviction-priority sort so the best names survive. Concentrates the thin
  // book instead of fragmenting the deploy budget across many tiny positions.
  // Keep coherent with the gross cap: max_open_names * max_position_pct should
  // be <= max_gross_exposure_pct, else the gross backstop binds first and this
  // cap is dead (default 3 * 5% = 15% = max_gross_exposure_pct).
  max_open_names: z.number().int().min(1).max(50).default(3),
  // Entries-only intraday timing blackout (wall-clock; feed-independent).
  // Avoids the RTH open/close vol+spread spikes and the deep-premarket /
  // late-afterhours liquidity vacuum. Exits are NEVER subject to this.
  entry_blackout: z
    .object({
      rth_open_min: z.number().int().min(0).max(120).default(10),
      rth_close_min: z.number().int().min(0).max(120).default(10),
      premarket_start_hm: z.string().regex(/^\d{2}:\d{2}$/).default('08:00'),
      afterhours_end_hm: z.string().regex(/^\d{2}:\d{2}$/).default('18:00'),
    })
    .default({}),
  // Entries-only blackout around scheduled binary macro events (CPI, FOMC,
  // payrolls). Wall-clock ET, feed-independent, exits NEVER gated — the same
  // discipline as entry_blackout, extended to a dated calendar. The calendar
  // is static config: no API dependency, no fail-open surprise. An empty list
  // means no gate; dates must be refreshed as agencies publish schedules
  // (docs/RUNBOOK.md). The macro analyst's event veto operates only at thesis
  // time (17:00 D-1); this gate is the execution-time backstop.
  macro_event_blackout: z
    .object({
      enabled: z.boolean().default(true),
      pre_min: z.number().int().min(0).max(240).default(30),
      post_min: z.number().int().min(0).max(240).default(15),
      events: z
        .array(
          z.object({
            date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), // ET calendar date
            hm: z.string().regex(/^\d{2}:\d{2}$/), // ET 24h release time
            label: z.string(),
          }),
        )
        .default([]),
    })
    .default({}),
  // Cross-day exposure backstop in the risk gate (entries only). Sits ABOVE
  // the per-day deploy cap: bounds the total book that can accumulate over
  // multiple sessions. Gross = sum of absolute position + resting-entry +
  // this-order notional; net = the signed version.
  max_gross_exposure_pct: z.number().positive().default(15),
  max_net_exposure_pct: z.number().positive().default(12),
  // Risk-parity sizing: a position is scaled DOWN when the name's annualized
  // realized vol exceeds this reference, so dollar risk is roughly equal
  // across names (an 80%-vol name gets half the size of a 40%-vol name).
  target_vol_pct: z.number().positive().default(40),
  // Deterministic per-position stop checked every executor tick, bypassing
  // the LLM judge. Caps intra-session drawdown; cannot stop a closed-market
  // overnight gap that jumps the level.
  max_position_loss_pct: z.number().positive().default(8),
  max_order_notional_usd: z.number().positive().default(2000),
  max_spread_bps: z.number().positive().default(50),
  // Quote source. 'iex' is the free tier and is BLIND during deep off-hours
  // (IEX trades 08:00-17:00 ET only); the staleness guard then makes the
  // executor safely abstain 17:00-20:00 and 04:00-08:00. 'sip' (paid
  // real-time subscription) sees the consolidated extended-hours book and is
  // required to actually trade the deep off-hours.
  data_feed: z.enum(['iex', 'sip']).default('iex'),
  // Fail-closed staleness guard: a quote older than this (vs the tick clock)
  // is treated as no quote, so the executor never trades on a stale book.
  max_quote_age_sec: z.number().positive().default(120),
  max_chase_pct: z.number().positive().default(1),
  max_drop_pct: z.number().positive().default(3),
  daily_loss_halt_pct: z.number().positive().default(3),
  executor_interval_min: z.number().int().positive().default(15),
  thesis_run_time_et: z.string().default('17:00'),
  // Backtest/report governance only (no trading effect): the report refuses to
  // print an economic PASS/FAIL verdict below this many headline-stratum
  // trades. Guards against an economic claim from a handful of trades. Paired
  // with the deflated-Sharpe hurdle and docs/TRIAL-REGISTRY.md.
  min_trades_for_economic_claim: z.number().int().min(0).default(50),

  // ---- P1-P3 quant signals (ALL ship flag-OFF; enable only after the paper
  // soak accumulates >=50 out-of-sample closed trades). Every one is a DOWN-
  // ONLY size multiplier, a fail-closed gate, or an ordering tweak — never a
  // directional vote, never injected into LLM prompts. See the design spec. ----

  // Multiplicative floor on the PRODUCT of the new down-only signal scalars, so
  // stacking (anti-chase * amihud * dispersion * regime ...) can never collapse
  // a position to a de-facto skip. Does NOT floor the existing volScalar.
  signal_scalar_floor: z.number().min(0).max(1).default(0.2),
  signals: z
    .object({
      // Short-term reversal: haircut a name that already ran hard in the
      // trade's direction (buying strength / shorting weakness is chasing).
      anti_chase: z
        .object({
          enabled: z.boolean().default(false),
          lookback_days: z.number().int().min(1).max(60).default(5),
          run_threshold_pct: z.number().min(0).default(10),
          haircut: z.number().min(0).max(1).default(0.5),
          band_tighten_pct: z.number().min(0).max(1).default(0.5),
        })
        .default({}),
      // Amihud illiquidity: haircut names whose price moves a lot per dollar
      // traded (thin books eat the edge). max_amihud 0 -> haircut only, no gate.
      amihud: z
        .object({
          enabled: z.boolean().default(false),
          window_days: z.number().int().min(2).max(60).default(20),
          max_amihud: z.number().min(0).default(0),
          size_haircut: z.number().min(0).max(1).default(0.5),
        })
        .default({}),
      // Analyst-ensemble dispersion (P2): shrink size when agreeing analysts
      // disagree in strength. k=0 ships inert (scalar always 1).
      dispersion: z
        .object({
          enabled: z.boolean().default(false),
          k: z.number().min(0).default(0),
          floor: z.number().min(0).max(1).default(0.6),
        })
        .default({}),
      // 12-1 momentum / 52wk-high counter-trend veto (P3): block entries that
      // fight a strong long-horizon trend. Needs ~252 daily bars.
      trend_gate: z
        .object({
          enabled: z.boolean().default(false),
          lookback_days: z.number().int().min(60).max(300).default(252),
          skip_days: z.number().int().min(0).max(40).default(21),
          min_pct_of_52w_high: z.number().min(0).max(1).default(0.75),
          contra_block: z.boolean().default(true),
        })
        .default({}),
      // Catalyst-gap continuation (P3): a big gap on volume is a catalyst;
      // fading it is dangerous. Contra-direction entries are gated/haircut.
      gap: z
        .object({
          enabled: z.boolean().default(false),
          min_gap_pct: z.number().min(0).default(3),
          min_rel_volume: z.number().min(0).default(2.0),
          contra_gate: z.boolean().default(true),
        })
        .default({}),
      // Low realized-vol candidate-ranking tiebreak (P3).
      low_vol: z.object({ prefer_low_vol: z.boolean().default(false) }).default({}),
    })
    .default({}),
  // Market regime overlays (P1 trend gate; P2 realized-vol + index-TSMOM).
  regime: z
    .object({
      trend: z
        .object({
          enabled: z.boolean().default(false),
          sma_long_days: z.number().int().min(20).max(300).default(200),
          hostile_long_scalar: z.number().min(0).max(1).default(0.4),
          hostile_short_scalar: z.number().min(0).max(1).default(1.0),
          benign_long_scalar: z.number().min(0).max(1).default(1.0),
          benign_short_scalar: z.number().min(0).max(1).default(0.6),
          threshold_bump: z.number().min(0).max(1).default(0),
        })
        .default({}),
      vol: z
        .object({
          enabled: z.boolean().default(false),
          lookback_days: z.number().int().min(5).max(60).default(20),
          percentile_window_days: z.number().int().min(60).max(504).default(252),
          elevated_pctile: z.number().min(0).max(1).default(0.8),
          stressed_pctile: z.number().min(0).max(1).default(0.95),
          elevated_scalar: z.number().min(0).max(1).default(0.6),
          stressed_scalar: z.number().min(0).max(1).default(0.3),
        })
        .default({}),
      gross: z
        .object({
          enabled: z.boolean().default(false),
          lookback_days: z.number().int().min(60).max(400).default(252),
          ma_days: z.number().int().min(20).max(300).default(200),
          risk_off_scalar: z.number().min(0).max(1).default(0.5),
        })
        .default({}),
    })
    .default({}),
  // Portfolio construction (P2). sizing_mode 'legacy' keeps per-name sizing;
  // 'inverse_vol' switches to conviction-tilted risk-parity basket weights.
  portfolio: z
    .object({
      sizing_mode: z.enum(['legacy', 'inverse_vol']).default('legacy'),
      target_vol: z.object({ enabled: z.boolean().default(false), pct: z.number().positive().default(20) }).default({}),
      // Covariance estimation window for the whole-book vol target / inverse-vol
      // sizing. Correlation enters here: the shrinkage covariance makes a book of
      // correlated names read as higher vol, so target-vol shrinks it more.
      cov_lookback_days: z.number().int().min(20).max(252).default(60),
      cov_shrinkage: z.enum(['constant_corr', 'single_factor', 'none']).default('constant_corr'),
    })
    .default({}),
  // Execution-quality signals (P1 cost scalar + participation; P3 placement).
  // Session-microstructure gates are SIP-only: on the default IEX feed they
  // stay at today's flat values and only tighten when data_feed='sip'.
  execution: z
    .object({
      cost_scalar: z
        .object({
          enabled: z.boolean().default(false),
          floor: z.number().min(0).max(1).default(0.5),
          max_roundtrip_cost_bps: z.number().min(0).default(45),
        })
        .default({}),
      participation: z
        .object({ enabled: z.boolean().default(false), max_top_size_fraction: z.number().min(0).default(0.25) })
        .default({}),
      // 1.0 = today's marketable band-clamp (all existing behavior); <1 rests
      // more passively inside the spread. SIP-sensitive; keep 1.0 on IEX.
      entry_aggressiveness: z.number().min(0).max(1).default(1),
      // Passive-first EXITS for non-risk triggers (target / time_stop / judge):
      // the first exit attempt rests inside the spread at `aggressiveness`
      // (0.5 = mid) instead of crossing; if it is still unfilled when the
      // trigger re-fires on a later tick, the exit escalates to marketable.
      // Risk triggers (hard_stop / invalidation_price / trail) ALWAYS cross —
      // urgency beats cost. Symmetric to entry_aggressiveness: the marketable
      // default paid the full spread on every non-urgent exit by construction.
      // Ships OFF: exit-path changes go through the paired-backtest / soak
      // discipline (trial-registry passive-exits-2026-07-28).
      exit_passive: z
        .object({
          enabled: z.boolean().default(false),
          aggressiveness: z.number().min(0).max(1).default(0.5),
        })
        .default({}),
      gates_by_session: z
        .object({
          enabled: z.boolean().default(false), // SIP-only; OFF -> flat gates apply
          rth: z.object({ max_spread_bps: z.number().positive().default(20), max_quote_age_sec: z.number().positive().default(20), min_top_size: z.number().min(0).default(100) }).default({}),
          premarket: z.object({ max_spread_bps: z.number().positive().default(80), max_quote_age_sec: z.number().positive().default(90), min_top_size: z.number().min(0).default(100) }).default({}),
          afterhours: z.object({ max_spread_bps: z.number().positive().default(80), max_quote_age_sec: z.number().positive().default(90), min_top_size: z.number().min(0).default(100) }).default({}),
        })
        .default({}),
      // Live short/borrow gate — ports the backtest checkShortable. Fail-closed
      // safety gate, default ON: a short proceeds only on a shortable and
      // (strict) easy-to-borrow name. Alpaca exposes no borrow rate, so
      // easy-to-borrow is the live proxy for the backtest's borrow-cost model.
      short_borrow_gate: z
        .object({
          enabled: z.boolean().default(true),
          require_easy_to_borrow: z.boolean().default(true),
        })
        .default({}),
      // Own-earnings guard (entries only, same family as macro_event_blackout):
      // never OPEN a position on a name scheduled to report within
      // block_days_ahead days — holding into the print is the largest single
      // gap-risk event a position faces. Exits are never gated. A held position
      // reporting within 1 day gets an `earnings_warning` audit (visibility;
      // forced flattening is deliberately NOT implemented — exit-path changes
      // go through the paired-backtest discipline). Calendar source is the
      // shared earnings cache (src/broker/earnings.ts); fetch failure fails
      // OPEN like the risk_off SPY fetch (core risk gates still apply), with
      // an audit line. Guardrail (risk control, not an edge signal).
      earnings_guard: z
        .object({
          enabled: z.boolean().default(false),
          block_days_ahead: z.number().int().min(0).max(10).default(2),
        })
        .default({}),
    })
    .default({}),
  // Book-level live risk overlays (P2), evaluated in the executor tick.
  risk_overlay: z
    .object({
      drawdown_throttle: z
        .object({ enabled: z.boolean().default(false), floor_pct: z.number().positive().default(3), min_throttle: z.number().min(0).max(1).default(0.25) })
        .default({}),
      risk_off: z
        .object({ enabled: z.boolean().default(false), spy_drop_pct: z.number().min(0).default(2.0), freeze_rest_of_session: z.boolean().default(true) })
        .default({}),
    })
    .default({}),
  // Monotone conviction calibration (P3). Ships as identity; a fitted table is
  // only valid once >=50 OOS closed trades exist (governance gate).
  calibration: z
    .object({
      enabled: z.boolean().default(false),
      min_trades: z.number().int().min(0).default(50),
      // sorted (score,winProb) breakpoints; empty -> identity map. prob is a
      // win PROBABILITY in [0,1] — bounding it keeps calibrated conviction <=1
      // so it can never inflate a position past the per-position cap.
      table: z.array(z.object({ score: z.number(), prob: z.number().min(0).max(1) })).default([]),
    })
    .default({}),
  // Deterministic exit engine (guardrail, spec 2026-07-11). enabled=true enforces
  // structured exit levels every tick; false reproduces the legacy static-stop +
  // judge path byte-for-byte. hard_stop_pct absent -> falls back to
  // max_position_loss_pct at resolve time, so defaults are a no-regression.
  exit_engine: z
    .object({
      enabled: z.boolean().default(true),
      hard_stop_pct: z.number().positive().optional(),
      // Optional tighter stop for shorts; falls back to hard_stop_pct.
      short_hard_stop_pct: z.number().positive().optional(),
      // Default trailing policy applied to every position (orphans included)
      // when the entry carries no trail of its own. Absent -> legacy behavior
      // (no trail unless the thesis emits one).
      trail: z
        .object({
          activate_pct: z.number().positive(),
          trail_pct: z.number().positive(),
          // Once armed, also exit on a full retrace to entry — guards configs
          // where trail_pct exceeds activate_pct.
          breakeven_floor: z.boolean().default(true),
          // Two-tier arming: breakeven floor arms at this lower gain %
          // (before activate_pct arms the HWM trail).
          breakeven_at_pct: z.number().positive().optional(),
        })
        .optional(),
      // Maintain a resting GTC broker stop per position at the trail floor
      // (src/trailing-stop.ts): protection that survives an engine outage.
      // Off by default — backtests must never enable it (SimLedger has no
      // stop-trigger semantics and fails loud).
      native_stop_ratchet: z.object({ enabled: z.boolean().default(false) }).default({}),
      // Live-only debounce for TRAIL-family exits (trail retrace + breakeven
      // floor): require the trigger on `confirm_ticks` consecutive ticks, and
      // only count a tick whose exit-side displayed size is at least
      // `min_exit_top_size` (same unit as the quote's bid/ask size — a 1-share
      // off-hours bid flicker must not liquidate a position into itself).
      // hard_stop / invalidation_price / target / time_stop are NEVER
      // debounced. Defaults (1 tick, size 0) are byte-identical to today, so
      // backtest cells are unaffected unless a cell opts in.
      trail_debounce: z
        .object({
          confirm_ticks: z.number().int().min(1).max(10).default(1),
          min_exit_top_size: z.number().min(0).default(0),
        })
        .default({}),
      // Data-quality gate on the trailing-PEAK ratchet (live executor only):
      // a quote may only advance the persisted favorable peak when the
      // displayed size behind the mark clears min_top_size. The peak never
      // decays, so one junk print would otherwise poison it permanently —
      // inflating the trail retrace and the ratcheted GTC stop level. 0 (the
      // default) is byte-identical to today. Crossed books are dropped
      // unconditionally upstream (partitionFreshQuotes) — invalid NBBO
      // snapshots are not prices and need no flag.
      peak_sanity: z
        .object({
          min_top_size: z.number().min(0).default(0),
        })
        .default({}),
      // Scale-out at target (Tier-3 machinery, ships FLAG-OFF): when enabled,
      // the target trigger exits only target_fraction of the position ONCE
      // (persisted marker), and the trail/time-stop/hard-stop manage the
      // remainder. All-or-nothing stays the default. ENABLE CONDITION is
      // pre-registered (trial-registry scale-out-exits-2026-07-27): the
      // feedback report's target-trigger bucket must show >= +1.5% average
      // 3-day post-exit follow-through over >= 15 target exits (systematic
      // money left on the table), THEN a paired backtest cell, THEN this flag.
      scale_out: z
        .object({
          enabled: z.boolean().default(false),
          target_fraction: z.number().min(0.1).max(0.9).default(0.5),
        })
        .default({}),
      // Fallback timeStopHours by verdict horizon (conservative; revisit on soak).
      horizon_hours: z
        .object({
          days: z.number().positive().default(30),
          weeks: z.number().positive().default(120),
        })
        .default({}),
    })
    .default({}),
  // Disk cache for executor-judge decisions (out/judge-cache.json), keyed on
  // the decision-relevant inputs — model, full thesis entry, headlines, and
  // position SIDE — and deliberately EXCLUDING the live quote: the judge is
  // instructed not to re-derive numbers (all quantitative gates are code-
  // enforced), so unchanged entry+headlines must yield the same decision
  // instead of re-rolling LLM nondeterminism every tick. This is also the
  // decline cooldown: a declined entry stays declined until its inputs change.
  // Default OFF so backtest cells (which replay many ticks against the
  // canonical quote-inclusive cache) are byte-identical; enabled in config.yaml
  // for the live executor.
  judge_cache: z
    .object({
      enabled: z.boolean().default(false),
      max_age_hours: z.number().positive().default(72),
    })
    .default({}),
  // Re-entry cooldown: block a NEW entry on any name that already had an exit
  // order or a filled protective stop today (derived from broker order history,
  // so it is crash-safe and stateless). Prevents stop-out -> re-buy churn on
  // the same thesis. Default OFF for backtest parity; enabled in config.yaml.
  entry_cooldown_after_exit: z.boolean().default(false),
  model: z
    .object({
      analysts: z.string().default('claude-sonnet-5'),
      synthesizer: z.string().default('claude-fable-5'),
      executor: z.string().default('claude-sonnet-5'),
      // Model-deprecation BRIDGE (registry row model-bridge-2026-07-28): when
      // set, the pipeline re-runs the verdict round on this model with inputs
      // identical to the primary round, writes verdicts-shadow-<ymd>.json, and
      // audits agreement stats. NOTHING from the shadow round is traded and a
      // shadow failure never blocks the pipeline. Purpose: when the frozen
      // primary model is deprecated by the vendor, weeks of paired shadow
      // output are the evidence for arguing OOS-counter continuity instead of
      // the full reset rule 1 would otherwise force. Unset = off (no cost).
      shadow_analysts: z.string().optional(),
      // Per-persona model overrides for ensemble diversity experiments: a set
      // analyst uses its own model, unset analysts fall back to `analysts`.
      // Ships EMPTY (no live change) — enabling is an A/B decision that goes
      // through a paired backtest per the trial registry, not taste. NOTE:
      // model IDs are frozen for the duration of a soak evaluation window
      // (registry row soak-reset-2026-07-27) — a mid-soak model change makes
      // the OOS sample non-stationary and resets the trade counter.
      analysts_by_name: z
        .object({
          fundamental: z.string().optional(),
          technical: z.string().optional(),
          macro: z.string().optional(),
          sentiment: z.string().optional(),
          bear: z.string().optional(),
        })
        .default({}),
    })
    .default({}),
});

export type Config = z.infer<typeof ConfigSchema>;

export const CONFIG_PATH = path.resolve(process.cwd(), 'config.yaml');

export function loadConfig(configPath: string = CONFIG_PATH): Config {
  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = ConfigSchema.safeParse(parseYaml(raw));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`invalid config at ${configPath}: ${issues}`);
  }
  return parsed.data;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Merge a PATCH fragment into the current value at any depth: plain objects
 * merge key-by-key, everything else (scalars, arrays, null) replaces whole.
 * Arrays are atomic values here — element-wise merging would leave phantom
 * on-disk entries behind a shorter patched array.
 */
function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch;
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    merged[key] = deepMerge(base[key], value);
  }
  return merged;
}

/**
 * Validate and persist a config update, treated as a PATCH: fields omitted
 * from the body keep their on-disk values instead of resetting to schema
 * defaults (a partial body must never silently loosen a risk cap). The merge
 * is recursive, so this holds at every nesting depth, not just the top level.
 * `mode` and `live_trading_acknowledged` are immutable through this path:
 * whatever the caller sends, the on-disk values are kept. Switching to live
 * requires editing config.yaml by hand.
 */
export function saveConfig(next: unknown, configPath: string = CONFIG_PATH): Config {
  const current = loadConfig(configPath);
  if (next === null || typeof next !== 'object' || Array.isArray(next)) {
    throw new Error('invalid config: body must be an object');
  }
  const candidate = deepMerge(current, next);
  const parsed = ConfigSchema.safeParse(candidate);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`invalid config: ${issues}`);
  }
  const merged: Config = {
    ...parsed.data,
    mode: current.mode,
    live_trading_acknowledged: current.live_trading_acknowledged,
  };
  const tmp = `${configPath}.tmp`;
  fs.writeFileSync(tmp, stringifyYaml(merged));
  fs.renameSync(tmp, configPath);
  return merged;
}

/**
 * Live mode requires ALL of: mode 'live', explicit acknowledgment flag, and
 * live credentials. Anything missing -> refuse to start. Never downgrade
 * silently to paper.
 */
export function assertModeRunnable(cfg: Config, env: NodeJS.ProcessEnv = process.env): void {
  if (cfg.mode !== 'live') return;
  const missing: string[] = [];
  if (cfg.live_trading_acknowledged !== true) {
    missing.push('live_trading_acknowledged: true in config.yaml');
  }
  if (!env.ALPACA_LIVE_KEY) missing.push('ALPACA_LIVE_KEY in .env');
  if (!env.ALPACA_LIVE_SECRET) missing.push('ALPACA_LIVE_SECRET in .env');
  if (missing.length > 0) {
    throw new Error(`refusing to start in live mode: missing ${missing.join(', ')}`);
  }
}
