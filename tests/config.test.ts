import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ConfigSchema,
  loadConfig,
  saveConfig,
  assertModeRunnable,
  type Config,
} from '../src/config.js';

let dir: string;
let configPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offhours-config-'));
  configPath = path.join(dir, 'config.yaml');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('ConfigSchema defaults', () => {
  it('fills every field from an empty object', () => {
    const cfg = ConfigSchema.parse({});
    expect(cfg.mode).toBe('paper');
    expect(cfg.live_trading_acknowledged).toBe(false);
    expect(cfg.universe).toEqual({
      nominations_per_agent: 5,
      max_candidates: 15,
      min_price: 5,
      min_avg_dollar_volume: 20_000_000,
      exclude: [],
    });
    expect(cfg.sessions).toEqual({ premarket: true, afterhours: true });
    expect(cfg.agent_weights).toEqual({
      fundamental: 1.0,
      technical: 0.8,
      macro: 0.6,
      sentiment: 1.0,
      bear: 1.2,
    });
    expect(cfg.conviction_threshold).toBe(0.65);
    expect(cfg.quorum).toBe(3);
    expect(cfg.max_position_pct).toBe(5);
    expect(cfg.max_daily_deploy_pct).toBe(10);
    expect(cfg.max_order_notional_usd).toBe(2000);
    expect(cfg.max_spread_bps).toBe(50);
    expect(cfg.max_chase_pct).toBe(1);
    expect(cfg.max_drop_pct).toBe(3);
    expect(cfg.daily_loss_halt_pct).toBe(3);
    expect(cfg.executor_interval_min).toBe(15);
    expect(cfg.thesis_run_time_et).toBe('17:00');
    expect(cfg.model).toEqual({
      analysts: 'claude-sonnet-5',
      synthesizer: 'claude-fable-5',
      executor: 'claude-sonnet-5',
    });
  });
});

describe('loadConfig', () => {
  it('parses a valid yaml file', () => {
    fs.writeFileSync(configPath, stringifyYaml({ mode: 'dry-run', quorum: 4 }));
    const cfg = loadConfig(configPath);
    expect(cfg.mode).toBe('dry-run');
    expect(cfg.quorum).toBe(4);
    expect(cfg.conviction_threshold).toBe(0.65);
  });

  it('rejects an invalid config with a readable message naming the field', () => {
    fs.writeFileSync(configPath, stringifyYaml({ mode: 'yolo', quorum: 9 }));
    expect(() => loadConfig(configPath)).toThrowError(/invalid config/);
    expect(() => loadConfig(configPath)).toThrowError(/mode/);
    expect(() => loadConfig(configPath)).toThrowError(/quorum/);
  });
});

describe('saveConfig', () => {
  it('cannot flip mode or live_trading_acknowledged', () => {
    fs.writeFileSync(
      configPath,
      stringifyYaml({ mode: 'paper', live_trading_acknowledged: false }),
    );
    const attempted = {
      ...ConfigSchema.parse({}),
      mode: 'live',
      live_trading_acknowledged: true,
      quorum: 4,
    };
    const saved = saveConfig(attempted, configPath);
    expect(saved.mode).toBe('paper');
    expect(saved.live_trading_acknowledged).toBe(false);
    expect(saved.quorum).toBe(4);

    const onDisk = ConfigSchema.parse(parseYaml(fs.readFileSync(configPath, 'utf8')));
    expect(onDisk.mode).toBe('paper');
    expect(onDisk.live_trading_acknowledged).toBe(false);
    expect(onDisk.quorum).toBe(4);
  });

  it('preserves a live mode already set on disk', () => {
    fs.writeFileSync(
      configPath,
      stringifyYaml({ mode: 'live', live_trading_acknowledged: true }),
    );
    const saved = saveConfig({ ...ConfigSchema.parse({}), mode: 'paper' }, configPath);
    expect(saved.mode).toBe('live');
    expect(saved.live_trading_acknowledged).toBe(true);
  });

  it('rejects invalid updates without touching the file', () => {
    fs.writeFileSync(configPath, stringifyYaml({ quorum: 2 }));
    expect(() => saveConfig({ quorum: 99 }, configPath)).toThrowError(/invalid config/);
    expect(loadConfig(configPath).quorum).toBe(2);
  });

  it('treats the body as a patch: omitted risk caps keep on-disk values, not defaults', () => {
    fs.writeFileSync(
      configPath,
      stringifyYaml({ max_order_notional_usd: 500, max_daily_deploy_pct: 2 }),
    );
    const saved = saveConfig({ quorum: 4 }, configPath);
    expect(saved.quorum).toBe(4);
    expect(saved.max_order_notional_usd).toBe(500); // NOT reset to default 2000
    expect(saved.max_daily_deploy_pct).toBe(2); // NOT reset to default 10
  });

  it('merges nested objects key-by-key instead of replacing them', () => {
    fs.writeFileSync(
      configPath,
      stringifyYaml({ universe: { min_price: 12, exclude: ['GME'] } }),
    );
    const saved = saveConfig({ universe: { max_candidates: 5 } }, configPath);
    expect(saved.universe.max_candidates).toBe(5);
    expect(saved.universe.min_price).toBe(12);
    expect(saved.universe.exclude).toEqual(['GME']);
  });

  it('rejects a non-object body', () => {
    fs.writeFileSync(configPath, stringifyYaml({ quorum: 2 }));
    expect(() => saveConfig('mode: live', configPath)).toThrowError(/must be an object/);
    expect(() => saveConfig(null, configPath)).toThrowError(/must be an object/);
  });
});

describe('assertModeRunnable', () => {
  const liveCfg = (ack: boolean): Config =>
    ConfigSchema.parse({ mode: 'live', live_trading_acknowledged: ack });
  const bothKeys = { ALPACA_LIVE_KEY: 'k', ALPACA_LIVE_SECRET: 's' };

  it('refuses live when live_trading_acknowledged is false', () => {
    expect(() => assertModeRunnable(liveCfg(false), bothKeys)).toThrowError(
      /refusing to start in live mode/,
    );
    expect(() => assertModeRunnable(liveCfg(false), bothKeys)).toThrowError(
      /live_trading_acknowledged/,
    );
  });

  it('refuses live when ALPACA_LIVE_KEY is missing', () => {
    expect(() =>
      assertModeRunnable(liveCfg(true), { ALPACA_LIVE_SECRET: 's' }),
    ).toThrowError(/ALPACA_LIVE_KEY/);
  });

  it('refuses live when ALPACA_LIVE_SECRET is missing', () => {
    expect(() => assertModeRunnable(liveCfg(true), { ALPACA_LIVE_KEY: 'k' })).toThrowError(
      /ALPACA_LIVE_SECRET/,
    );
  });

  it('refuses live when everything is missing, listing all three', () => {
    const run = () => assertModeRunnable(liveCfg(false), {});
    expect(run).toThrowError(/live_trading_acknowledged/);
    expect(run).toThrowError(/ALPACA_LIVE_KEY/);
    expect(run).toThrowError(/ALPACA_LIVE_SECRET/);
  });

  it('allows live when ack and both keys are present', () => {
    expect(() => assertModeRunnable(liveCfg(true), bothKeys)).not.toThrow();
  });

  it('allows paper and dry-run with an empty env', () => {
    expect(() => assertModeRunnable(ConfigSchema.parse({ mode: 'paper' }), {})).not.toThrow();
    expect(() => assertModeRunnable(ConfigSchema.parse({ mode: 'dry-run' }), {})).not.toThrow();
  });
});
