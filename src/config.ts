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
      min_price: z.number().positive().default(5),
      min_avg_dollar_volume: z.number().positive().default(20_000_000),
      exclude: z.array(z.string()).default([]),
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
      cov_lookback_days: z.number().int().min(20).max(252).default(60),
      cov_shrinkage: z.enum(['constant_corr', 'single_factor', 'none']).default('constant_corr'),
      correlation_sizing: z.boolean().default(false),
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
      gates_by_session: z
        .object({
          enabled: z.boolean().default(false), // SIP-only; OFF -> flat gates apply
          rth: z.object({ max_spread_bps: z.number().positive().default(20), max_quote_age_sec: z.number().positive().default(20), min_top_size: z.number().min(0).default(100) }).default({}),
          premarket: z.object({ max_spread_bps: z.number().positive().default(80), max_quote_age_sec: z.number().positive().default(90), min_top_size: z.number().min(0).default(100) }).default({}),
          afterhours: z.object({ max_spread_bps: z.number().positive().default(80), max_quote_age_sec: z.number().positive().default(90), min_top_size: z.number().min(0).default(100) }).default({}),
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
      // sorted (score,winProb) breakpoints; empty -> identity map.
      table: z.array(z.object({ score: z.number(), prob: z.number() })).default([]),
    })
    .default({}),
  model: z
    .object({
      analysts: z.string().default('claude-sonnet-5'),
      synthesizer: z.string().default('claude-fable-5'),
      executor: z.string().default('claude-sonnet-5'),
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

/**
 * Validate and persist a config update, treated as a PATCH: fields omitted
 * from the body keep their on-disk values instead of resetting to schema
 * defaults (a partial body must never silently loosen a risk cap).
 * `mode` and `live_trading_acknowledged` are immutable through this path:
 * whatever the caller sends, the on-disk values are kept. Switching to live
 * requires editing config.yaml by hand.
 */
export function saveConfig(next: unknown, configPath: string = CONFIG_PATH): Config {
  const current = loadConfig(configPath);
  if (next === null || typeof next !== 'object' || Array.isArray(next)) {
    throw new Error('invalid config: body must be an object');
  }
  const patch = next as Record<string, unknown>;
  const candidate: Record<string, unknown> = { ...current, ...patch };
  // one level of nesting: merge known object fields key-by-key
  for (const key of [
    'universe',
    'sessions',
    'agent_weights',
    'model',
    'entry_blackout',
    'signals',
    'regime',
    'portfolio',
    'execution',
    'risk_overlay',
    'calibration',
  ] as const) {
    if (patch[key] !== undefined) {
      if (patch[key] === null || typeof patch[key] !== 'object' || Array.isArray(patch[key])) {
        throw new Error(`invalid config: ${key} must be an object`);
      }
      candidate[key] = { ...current[key], ...(patch[key] as Record<string, unknown>) };
    }
  }
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
