import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stringify as toYaml } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigSchema } from '../src/config.js';
import {
  TRIAL_REGISTRY_PATH,
  alphaTrialCount,
  loadTrialRegistry,
  unregisteredEnabledAlphaFlags,
  unregisteredSweepFlags,
} from '../src/trial-registry.js';

let dir: string;
let p: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trial-'));
  p = path.join(dir, 'trial-registry.yaml');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
const write = (trials: unknown[]): void => fs.writeFileSync(p, toYaml({ trials }));

describe('trial registry', () => {
  it('loads rows and counts only alpha trials for nTrials', () => {
    write([
      { id: 'a', flag: 'signals.amihud', type: 'alpha', status: 's' },
      { id: 'b', flag: 'p0', type: 'guardrail', status: 's' },
    ]);
    const t = loadTrialRegistry(p);
    expect(t).toHaveLength(2);
    expect(alphaTrialCount(t)).toBe(1);
  });

  it('a missing registry file is empty (not an error)', () => {
    expect(loadTrialRegistry(path.join(dir, 'nope.yaml'))).toEqual([]);
  });

  it('an invalid schema throws naming the field', () => {
    fs.writeFileSync(p, toYaml({ trials: [{ id: 'a', flag: 'x', type: 'bogus', status: 's' }] }));
    expect(() => loadTrialRegistry(p)).toThrow(/invalid trial registry/);
  });

  it('default config (all signals off) has no unregistered enabled alpha flags', () => {
    write([]);
    expect(unregisteredEnabledAlphaFlags(ConfigSchema.parse({}), loadTrialRegistry(p))).toEqual([]);
  });

  it('enabling a signal WITHOUT a registry row flags it (the gate bites)', () => {
    write([]);
    const cfg = ConfigSchema.parse({ signals: { anti_chase: { enabled: true } } });
    expect(unregisteredEnabledAlphaFlags(cfg, loadTrialRegistry(p))).toEqual(['signals.anti_chase']);
  });

  it('a pre-registered alpha row for that flag clears the gate', () => {
    write([{ id: 'ac', flag: 'signals.anti_chase', type: 'alpha', status: 'pre-registered' }]);
    const cfg = ConfigSchema.parse({ signals: { anti_chase: { enabled: true } } });
    expect(unregisteredEnabledAlphaFlags(cfg, loadTrialRegistry(p))).toEqual([]);
  });

  it('detects non-boolean-flag signals: inverse_vol sizing and aggressiveness<1', () => {
    write([]);
    const cfg = ConfigSchema.parse({
      portfolio: { sizing_mode: 'inverse_vol' },
      execution: { entry_aggressiveness: 0.75 },
    });
    expect(unregisteredEnabledAlphaFlags(cfg, loadTrialRegistry(p)).sort()).toEqual([
      'execution.entry_aggressiveness',
      'portfolio.inverse_vol',
    ]);
  });

  it('nTrials sums the cells field over alpha rows (cells defaults to 1)', () => {
    write([
      { id: 'a', flag: 'conviction_threshold', type: 'alpha', status: 'complete', cells: 33 },
      { id: 'b', flag: 'sweep', type: 'alpha', status: 'invalid', cells: 59 },
      { id: 'c', flag: 'signals.amihud', type: 'alpha', status: 'pre-registered' },
      { id: 'd', flag: 'p0', type: 'guardrail', status: 'shipped', cells: 99 },
    ]);
    expect(alphaTrialCount(loadTrialRegistry(p))).toBe(33 + 59 + 1);
  });

  it('the sweep gate accepts flags covered by a campaign flags list', () => {
    write([
      {
        id: 'campaign',
        flag: 'signal-toggle-sweep',
        flags: ['signals.amihud', 'signals.gap'],
        type: 'alpha',
        status: 'complete',
        cells: 14,
      },
    ]);
    const t = loadTrialRegistry(p);
    expect(unregisteredSweepFlags(['signals.amihud', 'signals.gap'], t)).toEqual([]);
    expect(unregisteredSweepFlags(['signals.amihud', 'regime.vol'], t)).toEqual(['regime.vol']);
  });

  it('a campaign flags list does NOT clear the live-enable gate (search != deployment)', () => {
    write([
      {
        id: 'campaign',
        flag: 'signal-toggle-sweep',
        flags: ['signals.anti_chase'],
        type: 'alpha',
        status: 'complete',
        cells: 14,
      },
    ]);
    const cfg = ConfigSchema.parse({ signals: { anti_chase: { enabled: true } } });
    expect(unregisteredEnabledAlphaFlags(cfg, loadTrialRegistry(p))).toEqual(['signals.anti_chase']);
  });

  it('guardrail rows never register sweep flags', () => {
    write([{ id: 'g', flag: 'signals.gap', flags: ['signals.amihud'], type: 'guardrail', status: 's' }]);
    expect(unregisteredSweepFlags(['signals.gap', 'signals.amihud'], loadTrialRegistry(p)).sort()).toEqual([
      'signals.amihud',
      'signals.gap',
    ]);
  });

  it('the checked-in registry is valid and the DSR correction is not inert (nTrials >> 1)', () => {
    const t = loadTrialRegistry(TRIAL_REGISTRY_PATH);
    expect(alphaTrialCount(t)).toBeGreaterThanOrEqual(100);
  });
});
