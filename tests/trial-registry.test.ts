import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stringify as toYaml } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigSchema } from '../src/config.js';
import {
  TRIAL_REGISTRY_PATH,
  alphaTrialCount,
  enabledAlphaFlagsLackingMechanism,
  loadTrialRegistry,
  mechanismProblems,
  sweepFlagsLackingMechanism,
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

  it('guardrail rows register sweep flags (paired risk-shape cells) but never live enables', () => {
    write([{ id: 'g', flag: 'signals.gap', flags: ['signals.amihud'], type: 'guardrail', status: 's' }]);
    const trials = loadTrialRegistry(p);
    // Sweep gate: covered — a guardrail sweep still requires pre-registration.
    expect(unregisteredSweepFlags(['signals.gap', 'signals.amihud'], trials)).toEqual([]);
    // Live gate: NOT covered — enabling live still needs a type:alpha row.
    const cfg = ConfigSchema.parse({ signals: { gap: { enabled: true } } });
    expect(unregisteredEnabledAlphaFlags(cfg, trials)).toEqual(['signals.gap']);
  });

  it('the checked-in registry is valid and the DSR correction is not inert (nTrials >> 1)', () => {
    const t = loadTrialRegistry(TRIAL_REGISTRY_PATH);
    expect(alphaTrialCount(t)).toBeGreaterThanOrEqual(100);
  });
});

describe('mechanism gate (three sentences before a row authorizes work)', () => {
  const mech = {
    counterparty: 'market-on-open index rebalancers in thin small caps',
    whyTheyPay: 'they must trade at fixed times regardless of price',
    friction: 'names too small for institutional desks to arbitrage at size',
  };

  it('an alpha row without mechanism reports all three missing questions', () => {
    write([{ id: 'a', flag: 'signals.gap', type: 'alpha', status: 'pre-registered' }]);
    const problems = mechanismProblems(loadTrialRegistry(p)[0]!);
    expect(problems).toHaveLength(3);
    expect(problems.join(' ')).toMatch(/counterparty/);
    expect(problems.join(' ')).toMatch(/whyTheyPay/);
    expect(problems.join(' ')).toMatch(/friction/);
  });

  it('placeholder text ("tbd") fails the sentence floor, field by field', () => {
    write([
      {
        id: 'a',
        flag: 'signals.gap',
        type: 'alpha',
        status: 'pre-registered',
        mechanism: { ...mech, whyTheyPay: 'tbd' },
      },
    ]);
    const problems = mechanismProblems(loadTrialRegistry(p)[0]!);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/mechanism\.whyTheyPay/);
  });

  it('a full mechanism statement has no problems; guardrail rows never need one', () => {
    write([
      { id: 'a', flag: 'signals.gap', type: 'alpha', status: 'pre-registered', mechanism: mech },
      { id: 'g', flag: 'p0', type: 'guardrail', status: 'shipped' },
    ]);
    const t = loadTrialRegistry(p);
    expect(mechanismProblems(t[0]!)).toEqual([]);
    expect(mechanismProblems(t[1]!)).toEqual([]);
  });

  it('live enable: a registered row without mechanism blocks; with mechanism clears', () => {
    const cfg = ConfigSchema.parse({ signals: { anti_chase: { enabled: true } } });
    write([{ id: 'ac', flag: 'signals.anti_chase', type: 'alpha', status: 'pre-registered' }]);
    expect(unregisteredEnabledAlphaFlags(cfg, loadTrialRegistry(p))).toEqual([]);
    expect(enabledAlphaFlagsLackingMechanism(cfg, loadTrialRegistry(p))).toEqual(['signals.anti_chase']);
    write([
      { id: 'ac', flag: 'signals.anti_chase', type: 'alpha', status: 'pre-registered', mechanism: mech },
    ]);
    expect(enabledAlphaFlagsLackingMechanism(cfg, loadTrialRegistry(p))).toEqual([]);
  });

  it('live enable: an UNregistered flag is the other gate\'s job, not double-reported here', () => {
    write([]);
    const cfg = ConfigSchema.parse({ signals: { anti_chase: { enabled: true } } });
    expect(enabledAlphaFlagsLackingMechanism(cfg, loadTrialRegistry(p))).toEqual([]);
    expect(unregisteredEnabledAlphaFlags(cfg, loadTrialRegistry(p))).toEqual(['signals.anti_chase']);
  });

  it('sweep: flags covered only by mechanism-less rows are refused; a mechanism row authorizes', () => {
    write([
      {
        id: 'legacy',
        flag: 'signal-toggle-sweep',
        flags: ['signals.amihud', 'signals.gap'],
        type: 'alpha',
        status: 'complete',
        cells: 14,
      },
    ]);
    expect(sweepFlagsLackingMechanism(['signals.amihud', 'signals.gap'], loadTrialRegistry(p))).toEqual([
      'signals.amihud',
      'signals.gap',
    ]);
    write([
      {
        id: 'legacy',
        flag: 'signal-toggle-sweep',
        flags: ['signals.amihud', 'signals.gap'],
        type: 'alpha',
        status: 'complete',
        cells: 14,
      },
      {
        id: 'new-campaign',
        flag: 'signal-toggle-sweep',
        flags: ['signals.amihud'],
        type: 'alpha',
        status: 'pre-registered',
        mechanism: mech,
      },
    ]);
    expect(sweepFlagsLackingMechanism(['signals.amihud', 'signals.gap'], loadTrialRegistry(p))).toEqual([
      'signals.gap',
    ]);
  });

  it('sweep: unregistered flags are not reported by the mechanism gate (existence gate fires first)', () => {
    write([]);
    expect(sweepFlagsLackingMechanism(['signals.amihud'], loadTrialRegistry(p))).toEqual([]);
  });

  it('the checked-in registry grandfathers: legacy rows count for nTrials but authorize no new sweeps', () => {
    // As of 2026-07-10 no checked-in row carries a mechanism statement. When a
    // mechanism-bearing campaign row lands, update this expectation deliberately.
    const t = loadTrialRegistry(TRIAL_REGISTRY_PATH);
    expect(sweepFlagsLackingMechanism(['signals.amihud'], t)).toEqual(['signals.amihud']);
  });
});

describe('guardrail sweep coverage (paired risk-shape cells)', () => {
  it('a guardrail row registers its flag for the sweep gate', () => {
    write([{ id: 'exit-engine-v1', flag: 'exit_engine', type: 'guardrail', status: 'pre-registered' }]);
    expect(unregisteredSweepFlags(['exit_engine'], loadTrialRegistry(p))).toEqual([]);
  });

  it('a guardrail row authorizes its sweep without a mechanism (risk control, not edge)', () => {
    write([{ id: 'exit-engine-v1', flag: 'exit_engine', type: 'guardrail', status: 'pre-registered' }]);
    expect(sweepFlagsLackingMechanism(['exit_engine'], loadTrialRegistry(p))).toEqual([]);
  });

  it('an unregistered guardrail flag still refuses the sweep', () => {
    write([]);
    expect(unregisteredSweepFlags(['exit_engine'], loadTrialRegistry(p))).toEqual(['exit_engine']);
  });

  it('guardrail rows never count toward nTrials', () => {
    write([
      { id: 'exit-engine-v1', flag: 'exit_engine', type: 'guardrail', status: 'pre-registered', cells: 2 },
      { id: 'a', flag: 'signals.amihud', type: 'alpha', status: 's', cells: 3 },
    ]);
    expect(alphaTrialCount(loadTrialRegistry(p))).toBe(3);
  });
});
