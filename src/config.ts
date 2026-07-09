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
  // dust and quantization error dominates the intended sizing.
  min_position_notional_usd: z.number().min(0).default(250),
  // Cap on the number of entries a single thesis emits, applied AFTER the
  // conviction-priority sort so the best names survive. Concentrates the thin
  // book instead of fragmenting the deploy budget across many tiny positions.
  max_open_names: z.number().int().min(1).max(50).default(5),
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
  for (const key of ['universe', 'sessions', 'agent_weights', 'model', 'entry_blackout'] as const) {
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
