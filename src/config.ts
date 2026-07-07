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
  max_position_pct: z.number().positive().default(5),
  max_daily_deploy_pct: z.number().positive().default(10),
  max_order_notional_usd: z.number().positive().default(2000),
  max_spread_bps: z.number().positive().default(50),
  max_chase_pct: z.number().positive().default(1),
  max_drop_pct: z.number().positive().default(3),
  daily_loss_halt_pct: z.number().positive().default(3),
  executor_interval_min: z.number().int().positive().default(15),
  thesis_run_time_et: z.string().default('17:00'),
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
 * Validate and persist a config update. `mode` and `live_trading_acknowledged`
 * are immutable through this path: whatever the caller sends, the on-disk
 * values are kept. Switching to live requires editing config.yaml by hand.
 */
export function saveConfig(next: unknown, configPath: string = CONFIG_PATH): Config {
  const current = loadConfig(configPath);
  const parsed = ConfigSchema.safeParse(next);
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
