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
    expect(cfg.sessions).toEqual({ premarket: true, afterhours: true, regularhours: false });
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
    // quant P0 knobs
    expect(cfg.deploy_priority).toBe('conviction');
    expect(cfg.min_position_notional_usd).toBe(250);
    expect(cfg.max_open_names).toBe(3); // coherent with 15% gross / 5% per-position

    expect(cfg.max_gross_exposure_pct).toBe(15);
    expect(cfg.max_net_exposure_pct).toBe(12);
    expect(cfg.min_trades_for_economic_claim).toBe(50);
    expect(cfg.entry_blackout).toEqual({
      rth_open_min: 10,
      rth_close_min: 10,
      premarket_start_hm: '08:00',
      afterhours_end_hm: '18:00',
    });
    // P1–P3 signals ALL ship flag-off / inert
    expect(cfg.signal_scalar_floor).toBe(0.2);
    expect(cfg.signals.anti_chase.enabled).toBe(false);
    expect(cfg.signals.amihud.enabled).toBe(false);
    expect(cfg.signals.dispersion.enabled).toBe(false);
    expect(cfg.signals.trend_gate.enabled).toBe(false);
    expect(cfg.signals.gap.enabled).toBe(false);
    expect(cfg.signals.low_vol.prefer_low_vol).toBe(false);
    expect(cfg.regime.trend.enabled).toBe(false);
    expect(cfg.regime.vol.enabled).toBe(false);
    expect(cfg.regime.gross.enabled).toBe(false);
    expect(cfg.portfolio.sizing_mode).toBe('legacy');
    expect(cfg.portfolio.target_vol.enabled).toBe(false);
    expect(cfg.execution.entry_aggressiveness).toBe(1);
    expect(cfg.execution.cost_scalar.enabled).toBe(false);
    expect(cfg.execution.participation.enabled).toBe(false);
    expect(cfg.execution.gates_by_session.enabled).toBe(false);
    expect(cfg.risk_overlay.drawdown_throttle.enabled).toBe(false);
    expect(cfg.risk_overlay.risk_off.enabled).toBe(false);
    expect(cfg.calibration.enabled).toBe(false);
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
    expect(() => saveConfig({ universe: 5 }, configPath)).toThrowError(/invalid config/);
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

  it('merges entry_blackout key-by-key like the other nested objects', () => {
    fs.writeFileSync(configPath, stringifyYaml({ entry_blackout: { rth_open_min: 20 } }));
    const saved = saveConfig({ entry_blackout: { afterhours_end_hm: '17:00' } }, configPath);
    expect(saved.entry_blackout.rth_open_min).toBe(20); // preserved from disk, not reset
    expect(saved.entry_blackout.afterhours_end_hm).toBe('17:00'); // patched
    expect(saved.entry_blackout.rth_close_min).toBe(10); // default filled
  });

  it('merges the new signal config objects key-by-key (e.g. execution)', () => {
    fs.writeFileSync(configPath, stringifyYaml({ execution: { entry_aggressiveness: 0.75 } }));
    const saved = saveConfig({ execution: { participation: { enabled: true } } }, configPath);
    expect(saved.execution.entry_aggressiveness).toBe(0.75); // preserved from disk
    expect(saved.execution.participation.enabled).toBe(true); // patched
    expect(saved.execution.cost_scalar.enabled).toBe(false); // default filled
  });

  it('merges doubly-nested objects: patching one gates_by_session field keeps the rest', () => {
    fs.writeFileSync(
      configPath,
      stringifyYaml({
        execution: {
          gates_by_session: {
            enabled: true,
            rth: { max_spread_bps: 25 },
            premarket: { max_quote_age_sec: 60 },
          },
        },
      }),
    );
    const saved = saveConfig(
      { execution: { gates_by_session: { premarket: { max_spread_bps: 60 } } } },
      configPath,
    );
    expect(saved.execution.gates_by_session.premarket.max_spread_bps).toBe(60); // patched
    expect(saved.execution.gates_by_session.enabled).toBe(true); // NOT flipped back to default false
    expect(saved.execution.gates_by_session.rth.max_spread_bps).toBe(25); // NOT reset to default 20
    expect(saved.execution.gates_by_session.premarket.max_quote_age_sec).toBe(60); // sibling kept from disk
  });

  it('keeps on-disk siblings of a doubly-nested patched field instead of schema defaults', () => {
    fs.writeFileSync(
      configPath,
      stringifyYaml({ signals: { anti_chase: { enabled: true, lookback_days: 10, haircut: 0.3 } } }),
    );
    const saved = saveConfig({ signals: { anti_chase: { run_threshold_pct: 15 } } }, configPath);
    expect(saved.signals.anti_chase.run_threshold_pct).toBe(15); // patched
    expect(saved.signals.anti_chase.enabled).toBe(true); // NOT reset to default false
    expect(saved.signals.anti_chase.lookback_days).toBe(10); // NOT reset to default 5
    expect(saved.signals.anti_chase.haircut).toBe(0.3); // NOT reset to default 0.5
  });

  it('drops a __proto__ key from a JSON body instead of mutating the prototype', () => {
    fs.writeFileSync(configPath, stringifyYaml({ quorum: 2 }));
    // JSON.parse creates an own '__proto__' key, as express.json() would
    const body = JSON.parse('{"__proto__": {"quorum": 5}, "min_agreeing": 1}');
    const saved = saveConfig(body, configPath);
    expect(saved.quorum).toBe(2); // on-disk value, not smuggled via the prototype chain
    expect(saved.min_agreeing).toBe(1); // rest of the patch still applies
    expect(Object.getPrototypeOf(saved)).toBe(Object.prototype);
  });

  it('replaces arrays whole instead of merging element-wise', () => {
    fs.writeFileSync(
      configPath,
      stringifyYaml({
        universe: { exclude: ['GME', 'AMC'] },
        calibration: {
          min_trades: 60,
          table: [
            { score: 0.5, prob: 0.6 },
            { score: 0.8, prob: 0.7 },
          ],
        },
      }),
    );
    const saved = saveConfig(
      { universe: { exclude: ['TSLA'] }, calibration: { table: [{ score: 0.6, prob: 0.65 }] } },
      configPath,
    );
    expect(saved.universe.exclude).toEqual(['TSLA']); // no phantom leftovers from disk
    expect(saved.calibration.table).toEqual([{ score: 0.6, prob: 0.65 }]);
    expect(saved.calibration.min_trades).toBe(60); // sibling still merged from disk
  });

  it('merges exit_engine key-by-key like the other nested objects', () => {
    fs.writeFileSync(
      configPath,
      stringifyYaml({ exit_engine: { hard_stop_pct: 6, horizon_hours: { days: 20, weeks: 90 } } }),
    );
    const saved = saveConfig({ exit_engine: { short_hard_stop_pct: 4 } }, configPath);
    expect(saved.exit_engine.hard_stop_pct).toBe(6); // preserved from disk
    expect(saved.exit_engine.short_hard_stop_pct).toBe(4); // patched
    expect(saved.exit_engine.enabled).toBe(true); // default filled
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

describe('exit_engine config', () => {
  it('defaults: enabled, no explicit stop overrides, conservative horizon hours', () => {
    const cfg = ConfigSchema.parse({});
    expect(cfg.exit_engine).toEqual({
      enabled: true,
      horizon_hours: { days: 30, weeks: 120 },
    });
  });

  it('accepts explicit stop overrides and horizon hours', () => {
    const cfg = ConfigSchema.parse({
      exit_engine: { hard_stop_pct: 6, short_hard_stop_pct: 4, horizon_hours: { days: 12, weeks: 60 } },
    });
    expect(cfg.exit_engine.hard_stop_pct).toBe(6);
    expect(cfg.exit_engine.short_hard_stop_pct).toBe(4);
    expect(cfg.exit_engine.horizon_hours).toEqual({ days: 12, weeks: 60 });
  });

  it('rejects a non-positive hard stop', () => {
    expect(() => ConfigSchema.parse({ exit_engine: { hard_stop_pct: 0 } })).toThrow();
  });
});

describe('macro_event_blackout config', () => {
  it('defaults: enabled with an empty calendar (inert) and 30/15 windows', () => {
    const cfg = ConfigSchema.parse({});
    expect(cfg.macro_event_blackout).toEqual({ enabled: true, pre_min: 30, post_min: 15, events: [] });
  });

  it('accepts a calendar of dated ET events', () => {
    const cfg = ConfigSchema.parse({
      macro_event_blackout: {
        events: [{ date: '2026-08-12', hm: '08:30', label: 'CPI' }],
      },
    });
    expect(cfg.macro_event_blackout.events).toHaveLength(1);
  });

  it('rejects malformed dates and times', () => {
    expect(() =>
      ConfigSchema.parse({ macro_event_blackout: { events: [{ date: '08/12/2026', hm: '08:30', label: 'CPI' }] } }),
    ).toThrow();
    expect(() =>
      ConfigSchema.parse({ macro_event_blackout: { events: [{ date: '2026-08-12', hm: '8:30am', label: 'CPI' }] } }),
    ).toThrow();
  });
});
