// Typed trial registry + the alpha-flag pre-registration gates. Makes the quant
// testing plan's multiple-testing discipline a build/preflight invariant rather
// than a convention: an enabled ALPHA signal with no pre-registered row refuses
// to trade, a backtest sweep over unregistered flags refuses to run, and
// nTrials for the deflated-Sharpe gate is the sum of `cells` over alpha rows
// (per-cell counting; a row without `cells` counts as 1).
// See docs/QUANT-TESTING-PLAN.md and docs/TRIAL-REGISTRY.md.
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { Config } from './config.js';

export const TrialSchema = z.object({
  id: z.string(),
  flag: z.string(), // config path under test, e.g. 'signals.anti_chase', or a campaign label
  type: z.enum(['alpha', 'guardrail']),
  status: z.string(),
  date: z.string().optional(), // registration date (when the row was written), NOT the data window
  window: z.string().optional(), // data window evaluated, e.g. "2026-01-01..2026-07-01"
  cells: z.number().int().positive().optional(), // evaluated config cells this row covers; default 1
  flags: z.array(z.string()).optional(), // additional flags a campaign row covers (backtest-search registration only)
  enabledDate: z.string().optional(),
  horizonDays: z.number().optional(),
  targetActiveN: z.number().optional(),
  notes: z.string().optional(),
});
export type Trial = z.infer<typeof TrialSchema>;

export const TrialRegistrySchema = z.object({ trials: z.array(TrialSchema).default([]) });

export const TRIAL_REGISTRY_PATH = path.resolve(process.cwd(), 'trial-registry.yaml');

export function loadTrialRegistry(p: string = TRIAL_REGISTRY_PATH): Trial[] {
  if (!fs.existsSync(p)) return [];
  const parsed = TrialRegistrySchema.safeParse(parseYaml(fs.readFileSync(p, 'utf8')));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`invalid trial registry at ${p}: ${issues}`);
  }
  return parsed.data.trials;
}

/**
 * nTrials for the deflated-Sharpe correction: the sum of `cells` over
 * alpha-type rows (per-cell counting; a row without `cells` counts as 1).
 * Counting rule: every priced evaluation of a config cell on the backtest
 * window counts, including re-runs of the same cell under changed harness or
 * gate settings and runs later judged invalid — over-counting only raises the
 * DSR benchmark (conservative); under-counting is the failure mode.
 */
export function alphaTrialCount(trials: Trial[]): number {
  return trials.filter((t) => t.type === 'alpha').reduce((s, t) => s + (t.cells ?? 1), 0);
}

/**
 * Flags covered by a backtest-search registration: the union of `flag` and
 * `flags` over alpha rows. Used by the SWEEP gate only — a campaign row's
 * `flags` list registers backtest search, not live deployment; the live
 * preflight gate matches `flag` exactly.
 */
export function registeredSweepFlags(trials: Trial[]): Set<string> {
  const out = new Set<string>();
  for (const t of trials) {
    if (t.type !== 'alpha') continue;
    out.add(t.flag);
    for (const f of t.flags ?? []) out.add(f);
  }
  return out;
}

/**
 * Sweep flags that lack any type:'alpha' registry coverage (flag or flags
 * list). A non-empty result must refuse the backtest sweep — search without a
 * registered trial count is exactly how the deflated-Sharpe correction went
 * inert. Existence-only check: a NEW campaign over already-registered flags
 * still requires appending a row (or bumping `cells`) before reading results.
 */
export function unregisteredSweepFlags(flags: string[], trials: Trial[]): string[] {
  const registered = registeredSweepFlags(trials);
  return [...new Set(flags)].filter((f) => !registered.has(f));
}

/**
 * The config flags that are ALPHA trials (a signal being tested for edge), each
 * with a predicate for whether it is currently enabled. The P0 guardrails
 * (deploy_priority, floors, caps, blackout) are NOT here — they are always-on
 * risk controls, not edge trials.
 */
export const ALPHA_FLAGS: { flag: string; enabled: (c: Config) => boolean }[] = [
  { flag: 'signals.anti_chase', enabled: (c) => c.signals.anti_chase.enabled },
  { flag: 'signals.amihud', enabled: (c) => c.signals.amihud.enabled },
  { flag: 'signals.dispersion', enabled: (c) => c.signals.dispersion.enabled },
  { flag: 'signals.trend_gate', enabled: (c) => c.signals.trend_gate.enabled },
  { flag: 'signals.gap', enabled: (c) => c.signals.gap.enabled },
  { flag: 'signals.low_vol', enabled: (c) => c.signals.low_vol.prefer_low_vol },
  { flag: 'regime.trend', enabled: (c) => c.regime.trend.enabled },
  { flag: 'regime.vol', enabled: (c) => c.regime.vol.enabled },
  { flag: 'regime.gross', enabled: (c) => c.regime.gross.enabled },
  { flag: 'portfolio.target_vol', enabled: (c) => c.portfolio.target_vol.enabled },
  { flag: 'portfolio.inverse_vol', enabled: (c) => c.portfolio.sizing_mode === 'inverse_vol' },
  { flag: 'execution.cost_scalar', enabled: (c) => c.execution.cost_scalar.enabled },
  { flag: 'execution.participation', enabled: (c) => c.execution.participation.enabled },
  { flag: 'execution.gates_by_session', enabled: (c) => c.execution.gates_by_session.enabled },
  { flag: 'execution.entry_aggressiveness', enabled: (c) => c.execution.entry_aggressiveness < 1 },
  { flag: 'risk_overlay.drawdown_throttle', enabled: (c) => c.risk_overlay.drawdown_throttle.enabled },
  { flag: 'risk_overlay.risk_off', enabled: (c) => c.risk_overlay.risk_off.enabled },
  { flag: 'calibration', enabled: (c) => c.calibration.enabled },
];

/**
 * Enabled alpha flags that lack a pre-registered type:'alpha' registry row.
 * A non-empty result is a preflight BLOCKER — enabling a signal without
 * pre-registering it is exactly the p-hacking the plan forbids.
 * Matches `flag` EXACTLY (not campaign `flags` lists): registering a backtest
 * sweep over a signal does not authorize enabling it live — that needs a
 * dedicated row whose `flag` is the signal's config path.
 */
export function unregisteredEnabledAlphaFlags(cfg: Config, trials: Trial[]): string[] {
  const registered = new Set(trials.filter((t) => t.type === 'alpha').map((t) => t.flag));
  return ALPHA_FLAGS.filter((f) => f.enabled(cfg) && !registered.has(f.flag)).map((f) => f.flag);
}
