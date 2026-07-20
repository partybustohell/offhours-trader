# Exit Engine + Macro-Event Entry Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the approved deterministic exit engine (spec `docs/superpowers/specs/2026-07-11-exit-discipline-design.md`) and add a deterministic entries-only blackout around scheduled macro events (CPI/FOMC/NFP).

**Architecture:** Workstream A replaces the single-static-stop-plus-LLM exit path with a pure, tick-enforced exit engine (`src/exits.ts`) whose numeric levels are committed at thesis time and enforced every tick, with the LLM judge demoted to a qualitative overlay. Workstream B extends the existing wall-clock `entry_blackout` discipline with a config-listed macro-event calendar. Both are guardrails: no new entry signal, no alpha claim, consistent with the Stage-0 STOP (no P1–P3 signal may be enabled until the paper soak has ≥50 out-of-sample closed trades).

**Tech Stack:** TypeScript/ESM, Node, Zod config schema, Vitest. File-driven state under `out/`. The backtest episode runner calls the real `runTick`, so executor changes apply to live and sim from one implementation.

**Why these two (evidence):**
- Exit engine: approved spec, pre-implementation. Live evidence 2026-07-14/15: an FSLR short opened off the RTH thesis ran overnight past thesis expiry with `no quote for exit check` on every off-hours tick — no time-stop, no structured invalidation level. Backtest reports show exits dominated by blind episode-boundary force-flattens.
- Event gate: June-CPI day (2026-07-14) analysis showed the executor may legally place premarket entries from 08:00 ET while CPI prints at 08:30 ET — a thesis formed at 17:00 the prior evening can be executed minutes before a known binary event. The macro analyst's veto exists only at thesis-formation time, not execution time.

**Out of scope (documented follow-ups, do not build):** enabling any P1–P3 quant signal (governance gate); scaling-out/partial exits; native OCO brackets; ATR stops; squeeze-aware short exits; orphan-position adoption (spec locks orphans to stop-only); RTH-thesis backtest fidelity (overnight news / morning scans in sim).

**Preconditions:** working tree currently holds a complete, tested live short-borrow gate (uncommitted). Task 0 lands it first so later executor edits build on a clean tree.

---

## File structure

| File | Change | Responsibility |
|---|---|---|
| `src/types.ts` | modify | `ExitPlan`, `ThesisEntry.exit?`, `ThesisEntry.horizon?` |
| `src/config.ts` | modify | `exit_engine` + `macro_event_blackout` schema blocks; saveConfig merge list |
| `src/exits.ts` | **create** | pure engine: `evaluateExit`, `resolveExitPlan`, `sanitizeExitPlan`, `mergedExitPlan` |
| `src/state.ts` | modify | per-position peak persistence (`trackPositionPeak`, `prunePositionPeaks`) |
| `src/paths.ts` | modify | `peaksPath()` |
| `src/synthesis.ts` | modify | dominant `horizon` on computed entries |
| `src/agents/narrative.ts` | modify | LLM emits structured `exit`; sanitized on parse |
| `src/agents/prompts.ts` | modify | synthesizer prompt: exit-block instructions |
| `src/pipeline.ts` | modify | merge LLM exit over deterministic fallback into thesis entries |
| `src/executor-loop.ts` | modify | engine enforcement, judge overlay, native stop leg from resolved plan, `exit_starved` + `event_blackout` audits, event gate |
| `src/session-risk.ts` | modify | `activeEventBlackout` pure function |
| `scripts/backtest-episode.ts` | modify | exit-trigger attribution into `EpisodeTrade.exitReason` |
| `src/backtest/metrics.ts` | modify | `exitTriggerOf`, `exitBreakdown`, report table |
| `scripts/backtest.ts` | modify | paired guardrail sweep cell (engine off) |
| `trial-registry.yaml`, `docs/TRIAL-REGISTRY.md` | modify | `exit-engine-v1` guardrail row |
| `config.yaml` | modify | `macro_event_blackout` seeded calendar |
| `README.md`, `docs/RUNBOOK.md` | modify | tuning docs + monthly calendar-refresh runbook note |
| Tests | create/modify | `tests/exits.test.ts`, `tests/executor-exit-engine.test.ts`, additions to `tests/config.test.ts`, `tests/state.test.ts`, `tests/session-risk.test.ts`, `tests/backtest-metrics.test.ts`, `tests/narrative.test.ts` |

Conventions: 2-space indent, single quotes, semicolons, `.js` import suffixes (ESM). Run a single test file with `pnpm vitest run tests/<file>` (or `pnpm test` for everything).

---

## Task 0: Land the in-flight short-borrow gate

The working tree already contains a complete, tested change (live short/borrow gate + `BrokerClient.getAsset`). Land it before touching the same files.

- [ ] **Step 1: Verify the tree state and test suite**

Run: `git status --short && pnpm test 2>&1 | tail -3`
Expected: modified files as listed in the diff (`src/executor-loop.ts`, `src/broker/client.ts`, `src/config.ts`, `src/backtest/ledger.ts`, `scripts/backtest-episode.ts`, `scripts/subagent-run.ts`, `tests/executor-helpers.test.ts`, `.gitignore`), and `Tests  220 passed`.

- [ ] **Step 2: Commit**

```bash
git add .gitignore scripts/backtest-episode.ts scripts/subagent-run.ts src/backtest/ledger.ts src/broker/client.ts src/config.ts src/executor-loop.ts tests/executor-helpers.test.ts
git commit -m "feat: live short/borrow gate (ports backtest checkShortable)"
```

Do NOT commit `docs/HOW-IT-WORKS.*`, `docs/how-it-works-formal.*`, or `.superpowers/` — leave them untracked.

---

## Task 1: `ExitPlan` type + `exit_engine` config block

**Files:**
- Modify: `src/types.ts` (after `SizingAttribution`, before `ThesisEntry`)
- Modify: `src/config.ts` (schema + saveConfig merge list)
- Test: `tests/config.test.ts`

- [ ] **Step 1: Write the failing config test**

Append to `tests/config.test.ts` (follow the file's existing describe style):

```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run tests/config.test.ts`
Expected: FAIL — `exit_engine` is undefined on the parsed config.

- [ ] **Step 3: Add the types**

In `src/types.ts`, insert immediately above `export interface ThesisEntry {`:

```ts
/**
 * Structured exit plan committed at thesis time and enforced every executor
 * tick by src/exits.ts (spec: docs/superpowers/specs/2026-07-11-exit-discipline-design.md).
 * All comparisons are direction-aware; absent optional fields simply never fire.
 */
export interface ExitPlan {
  /** Worst-case loss %, > 0; drives the native RTH stop leg AND the tick hard-stop check. */
  hardStopPct: number;
  /** Numeric thesis-death level (long: exit if mark <= level; short: >=). */
  invalidationPrice?: number;
  /** Take-profit price (long: mark >= target; short: <=). */
  target?: number;
  trail?: {
    /** Arm trailing once unrealized gain >= this %. */
    activatePct: number;
    /** Then exit if mark retraces this % from the favorable peak. */
    trailPct: number;
  };
  /** Exit if unresolved this many hours after entry (first-seen fallback). */
  timeStopHours?: number;
}
```

In `ThesisEntry`, add two optional fields after `invalidationConditions: string[];`:

```ts
  /** Dominant verdict horizon of the agreeing analysts; feeds the time-stop fallback. */
  horizon?: 'days' | 'weeks';
  /** Structured exit levels; absent on historical theses (fallbacks apply). */
  exit?: ExitPlan;
```

- [ ] **Step 4: Add the config schema block**

In `src/config.ts`, insert after the `calibration` block (before `model`):

```ts
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
      // Fallback timeStopHours by verdict horizon (conservative; revisit on soak).
      horizon_hours: z
        .object({
          days: z.number().positive().default(30),
          weeks: z.number().positive().default(120),
        })
        .default({}),
    })
    .default({}),
```

In `saveConfig`, add `'exit_engine'` to the nested-merge key list (the `for (const key of [...] as const)` array).

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run tests/config.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/config.ts tests/config.test.ts
git commit -m "feat: ExitPlan type + exit_engine config block"
```

---

## Task 2: `evaluateExit` — hard stop + invalidation price

**Files:**
- Create: `src/exits.ts`
- Test: `tests/exits.test.ts` (new)

- [ ] **Step 1: Write the failing tests**

Create `tests/exits.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { evaluateExit, type ExitContext } from '../src/exits.js';

const base: ExitContext = {
  direction: 'long',
  entryPrice: 100,
  entryTimeMs: 0,
  markPrice: 100,
  peakFavorablePrice: 100,
  nowMs: 0,
  plan: { hardStopPct: 8 },
};

describe('evaluateExit: hard stop', () => {
  it('fires for a long at exactly the stop level', () => {
    const d = evaluateExit({ ...base, markPrice: 92 });
    expect(d.exit).toBe(true);
    expect(d.trigger).toBe('hard_stop');
  });

  it('does not fire a hair above the stop level', () => {
    expect(evaluateExit({ ...base, markPrice: 92.01 }).exit).toBe(false);
  });

  it('fires for a short when the mark rises to the stop level', () => {
    const d = evaluateExit({ ...base, direction: 'short', markPrice: 108, peakFavorablePrice: 100 });
    expect(d.exit).toBe(true);
    expect(d.trigger).toBe('hard_stop');
  });

  it('never fires on a zero entry price (no basis)', () => {
    expect(evaluateExit({ ...base, entryPrice: 0, markPrice: 1 }).exit).toBe(false);
  });
});

describe('evaluateExit: invalidation price', () => {
  it('long exits when mark <= invalidation level', () => {
    const d = evaluateExit({
      ...base,
      plan: { hardStopPct: 50, invalidationPrice: 95 },
      markPrice: 95,
    });
    expect(d.exit).toBe(true);
    expect(d.trigger).toBe('invalidation_price');
  });

  it('long holds a hair above the invalidation level', () => {
    const d = evaluateExit({
      ...base,
      plan: { hardStopPct: 50, invalidationPrice: 95 },
      markPrice: 95.01,
    });
    expect(d.exit).toBe(false);
  });

  it('short exits when mark >= invalidation level', () => {
    const d = evaluateExit({
      ...base,
      direction: 'short',
      plan: { hardStopPct: 50, invalidationPrice: 105 },
      markPrice: 105,
    });
    expect(d.exit).toBe(true);
    expect(d.trigger).toBe('invalidation_price');
  });

  it('hard stop wins when both stop and invalidation are true', () => {
    const d = evaluateExit({
      ...base,
      plan: { hardStopPct: 8, invalidationPrice: 95 },
      markPrice: 92,
    });
    expect(d.trigger).toBe('hard_stop');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/exits.test.ts`
Expected: FAIL — `src/exits.ts` does not exist.

- [ ] **Step 3: Implement the engine skeleton with the first two triggers**

Create `src/exits.ts`:

```ts
// Deterministic, thesis-grounded exit engine (guardrail; spec
// docs/superpowers/specs/2026-07-11-exit-discipline-design.md). Pure module:
// no I/O, no clock, no LLM. The executor and the backtest episode runner both
// call evaluateExit so live and sim share one implementation. Priority order
// is risk-first and fixed: hard_stop > invalidation_price > target > trail >
// time_stop — the first trigger that fires wins (all-or-nothing exits).
import type { Config } from './config.js';
import type { ExitPlan, ThesisEntry } from './types.js';

export type ExitTrigger = 'hard_stop' | 'invalidation_price' | 'target' | 'trail' | 'time_stop';

export interface ExitContext {
  direction: 'long' | 'short';
  entryPrice: number; // broker avg_entry_price
  entryTimeMs: number; // first tick that observed the position (conservative)
  markPrice: number; // exit-side quote: long -> bid, short -> ask
  peakFavorablePrice: number; // high-water (long) / low-water (short) since entry
  nowMs: number;
  plan: ExitPlan; // resolved (post-fallback) plan
}

export interface ExitDecision {
  exit: boolean;
  reason?: string;
  trigger?: ExitTrigger;
}

export function evaluateExit(ctx: ExitContext): ExitDecision {
  const { direction, entryPrice, markPrice, plan } = ctx;
  const isLong = direction === 'long';

  // 1. hard_stop — risk first.
  if (entryPrice > 0) {
    const lossPct =
      ((isLong ? entryPrice - markPrice : markPrice - entryPrice) / entryPrice) * 100;
    if (lossPct >= plan.hardStopPct) {
      return {
        exit: true,
        trigger: 'hard_stop',
        reason: `hard_stop: unrealized loss ${lossPct.toFixed(1)}% >= ${plan.hardStopPct}%`,
      };
    }
  }

  // 2. invalidation_price — the thesis is dead at this level.
  if (plan.invalidationPrice !== undefined) {
    const dead = isLong ? markPrice <= plan.invalidationPrice : markPrice >= plan.invalidationPrice;
    if (dead) {
      return {
        exit: true,
        trigger: 'invalidation_price',
        reason: `invalidation_price: mark ${markPrice} ${isLong ? '<=' : '>='} ${plan.invalidationPrice}`,
      };
    }
  }

  return { exit: false };
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run tests/exits.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/exits.ts tests/exits.test.ts
git commit -m "feat: exit engine core — hard stop + invalidation price"
```

---

## Task 3: `evaluateExit` — target, trail, time stop, priority

**Files:**
- Modify: `src/exits.ts`
- Test: `tests/exits.test.ts`

- [ ] **Step 1: Write the failing tests** (append to `tests/exits.test.ts`)

```ts
describe('evaluateExit: target', () => {
  it('long take-profit at mark >= target', () => {
    const d = evaluateExit({ ...base, plan: { hardStopPct: 50, target: 110 }, markPrice: 110 });
    expect(d.exit).toBe(true);
    expect(d.trigger).toBe('target');
  });

  it('short take-profit at mark <= target', () => {
    const d = evaluateExit({
      ...base,
      direction: 'short',
      plan: { hardStopPct: 50, target: 90 },
      markPrice: 90,
    });
    expect(d.exit).toBe(true);
    expect(d.trigger).toBe('target');
  });

  it('invalidation outranks target when both are true', () => {
    const d = evaluateExit({
      ...base,
      plan: { hardStopPct: 50, invalidationPrice: 95, target: 94 },
      markPrice: 94,
    });
    expect(d.trigger).toBe('invalidation_price');
  });
});

describe('evaluateExit: trail', () => {
  const trailPlan = { hardStopPct: 50, trail: { activatePct: 5, trailPct: 2 } };

  it('long: armed by peak gain, exits on retrace from the peak', () => {
    const d = evaluateExit({
      ...base,
      plan: trailPlan,
      peakFavorablePrice: 106, // +6% >= activate 5%
      markPrice: 103.88, // retrace (106-103.88)/106 = 2.0%
    });
    expect(d.exit).toBe(true);
    expect(d.trigger).toBe('trail');
  });

  it('long: not armed below the activation gain', () => {
    const d = evaluateExit({
      ...base,
      plan: trailPlan,
      peakFavorablePrice: 104, // +4% < 5%: never armed
      markPrice: 100,
    });
    expect(d.exit).toBe(false);
  });

  it('short: peak is the LOW; exits when mark retraces up from it', () => {
    const d = evaluateExit({
      ...base,
      direction: 'short',
      plan: trailPlan,
      peakFavorablePrice: 94, // 6% favorable move down
      markPrice: 95.88, // (95.88-94)/94 = 2.0% retrace
    });
    expect(d.exit).toBe(true);
    expect(d.trigger).toBe('trail');
  });
});

describe('evaluateExit: time stop', () => {
  it('fires once the holding period reaches the limit', () => {
    const d = evaluateExit({
      ...base,
      plan: { hardStopPct: 50, timeStopHours: 24 },
      nowMs: 24 * 3_600_000,
    });
    expect(d.exit).toBe(true);
    expect(d.trigger).toBe('time_stop');
  });

  it('does not fire one ms before the limit', () => {
    const d = evaluateExit({
      ...base,
      plan: { hardStopPct: 50, timeStopHours: 24 },
      nowMs: 24 * 3_600_000 - 1,
    });
    expect(d.exit).toBe(false);
  });

  it('bare plan (hard stop only) never time-stops', () => {
    expect(evaluateExit({ ...base, nowMs: 10_000 * 3_600_000 }).exit).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/exits.test.ts`
Expected: FAIL — target/trail/time_stop tests fail (engine returns no-exit).

- [ ] **Step 3: Implement**

In `src/exits.ts`, replace the final `return { exit: false };` of `evaluateExit` with:

```ts
  // 3. target — pre-committed take-profit.
  if (plan.target !== undefined) {
    const hit = isLong ? markPrice >= plan.target : markPrice <= plan.target;
    if (hit) {
      return {
        exit: true,
        trigger: 'target',
        reason: `target: mark ${markPrice} ${isLong ? '>=' : '<='} ${plan.target}`,
      };
    }
  }

  // 4. trail — armed once the favorable move reached activatePct, then exits
  // when the mark retraces trailPct from the favorable peak (long: high; short: low).
  if (plan.trail && entryPrice > 0 && ctx.peakFavorablePrice > 0) {
    const gainPct =
      ((isLong ? ctx.peakFavorablePrice - entryPrice : entryPrice - ctx.peakFavorablePrice) /
        entryPrice) *
      100;
    if (gainPct >= plan.trail.activatePct) {
      const retracePct =
        ((isLong ? ctx.peakFavorablePrice - markPrice : markPrice - ctx.peakFavorablePrice) /
          ctx.peakFavorablePrice) *
        100;
      if (retracePct >= plan.trail.trailPct) {
        return {
          exit: true,
          trigger: 'trail',
          reason: `trail: retrace ${retracePct.toFixed(1)}% from peak ${ctx.peakFavorablePrice} >= ${plan.trail.trailPct}%`,
        };
      }
    }
  }

  // 5. time_stop — entry-relative horizon (replaces the blind boundary flatten).
  if (
    plan.timeStopHours !== undefined &&
    ctx.nowMs - ctx.entryTimeMs >= plan.timeStopHours * 3_600_000
  ) {
    const heldH = (ctx.nowMs - ctx.entryTimeMs) / 3_600_000;
    return {
      exit: true,
      trigger: 'time_stop',
      reason: `time_stop: held ${heldH.toFixed(1)}h >= ${plan.timeStopHours}h`,
    };
  }

  return { exit: false };
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run tests/exits.test.ts`
Expected: PASS (17 tests).

- [ ] **Step 5: Commit**

```bash
git add src/exits.ts tests/exits.test.ts
git commit -m "feat: exit engine — target, trail, time stop, priority order"
```

---

## Task 4: `resolveExitPlan` + `sanitizeExitPlan` + `mergedExitPlan`

Fallback resolution (config defaults; no entry can regress below today's protection) and direction-aware validation of LLM-emitted levels (a sign-confused level must be dropped, not enforced).

**Files:**
- Modify: `src/exits.ts`
- Test: `tests/exits.test.ts`

- [ ] **Step 1: Write the failing tests** (append to `tests/exits.test.ts`)

```ts
import { mergedExitPlan, resolveExitPlan, sanitizeExitPlan } from '../src/exits.js';
import { ConfigSchema } from '../src/config.js';

const cfg = ConfigSchema.parse({});

describe('resolveExitPlan', () => {
  it('orphan (no entry): stop-only at the config hard stop, no time stop', () => {
    expect(resolveExitPlan(undefined, cfg)).toEqual({ hardStopPct: 8 });
  });

  it('bare long entry: hard stop + days-horizon time stop (strict superset of today)', () => {
    expect(resolveExitPlan({ direction: 'long' }, cfg)).toEqual({
      hardStopPct: 8,
      timeStopHours: 30,
    });
  });

  it('weeks horizon uses the weeks fallback', () => {
    expect(resolveExitPlan({ direction: 'long', horizon: 'weeks' }, cfg).timeStopHours).toBe(120);
  });

  it('short_hard_stop_pct tightens shorts only', () => {
    const c = ConfigSchema.parse({ exit_engine: { short_hard_stop_pct: 5 } });
    expect(resolveExitPlan({ direction: 'short' }, c).hardStopPct).toBe(5);
    expect(resolveExitPlan({ direction: 'long' }, c).hardStopPct).toBe(8);
  });

  it('entry-carried exit fields override the fallbacks', () => {
    const plan = resolveExitPlan(
      { direction: 'long', exit: { hardStopPct: 4, target: 120, timeStopHours: 10 } },
      cfg,
    );
    expect(plan).toEqual({ hardStopPct: 4, target: 120, timeStopHours: 10 });
  });
});

describe('sanitizeExitPlan (LLM output validation)', () => {
  const band = { low: 97, high: 101 }; // long entry band around ~100

  it('maps snake_case fields and keeps well-formed values', () => {
    expect(
      sanitizeExitPlan(
        {
          hard_stop_pct: 6,
          invalidation_price: 95,
          target_price: 112,
          trail: { activate_pct: 5, trail_pct: 2 },
          time_stop_hours: 48,
        },
        'long',
        band,
      ),
    ).toEqual({
      hardStopPct: 6,
      invalidationPrice: 95,
      target: 112,
      trail: { activatePct: 5, trailPct: 2 },
      timeStopHours: 48,
    });
  });

  it('drops a long invalidation level that is not below the band', () => {
    expect(sanitizeExitPlan({ invalidation_price: 99 }, 'long', band)).toEqual({});
  });

  it('drops a long target that is not above the band', () => {
    expect(sanitizeExitPlan({ target_price: 100 }, 'long', band)).toEqual({});
  });

  it('short: invalidation must sit above the band, target below', () => {
    expect(
      sanitizeExitPlan({ invalidation_price: 105, target_price: 90 }, 'short', band),
    ).toEqual({ invalidationPrice: 105, target: 90 });
    expect(sanitizeExitPlan({ invalidation_price: 90, target_price: 105 }, 'short', band)).toEqual(
      {},
    );
  });

  it('drops non-finite, non-positive, and absurd values', () => {
    expect(
      sanitizeExitPlan(
        { hard_stop_pct: 80, invalidation_price: -5, target_price: NaN, time_stop_hours: 100000 },
        'long',
        band,
      ),
    ).toEqual({});
  });

  it('drops a trail missing either field', () => {
    expect(sanitizeExitPlan({ trail: { activate_pct: 5 } }, 'long', band)).toEqual({});
  });

  it('non-object input yields an empty plan', () => {
    expect(sanitizeExitPlan(null, 'long', band)).toEqual({});
    expect(sanitizeExitPlan('x', 'long', band)).toEqual({});
  });
});

describe('mergedExitPlan', () => {
  it('overlays sanitized LLM fields onto the deterministic fallback', () => {
    const merged = mergedExitPlan(
      { direction: 'long', horizon: 'days' },
      { invalidationPrice: 95 },
      cfg,
    );
    expect(merged).toEqual({ hardStopPct: 8, timeStopHours: 30, invalidationPrice: 95 });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/exits.test.ts`
Expected: FAIL — the three functions are not exported.

- [ ] **Step 3: Implement** (append to `src/exits.ts`)

```ts
/**
 * Resolve the enforceable plan for a position. undefined entry = orphan
 * position: stop-only at the config hard stop, exactly today's protection
 * (spec §7 locks orphans to stop-only). An entry present but bare degrades to
 * hard stop + horizon time-stop — a strict superset of today's protection.
 */
export function resolveExitPlan(
  entry: Pick<ThesisEntry, 'direction' | 'exit' | 'horizon'> | undefined,
  cfg: Config,
): ExitPlan {
  const baseStop = cfg.exit_engine.hard_stop_pct ?? cfg.max_position_loss_pct;
  if (!entry) return { hardStopPct: baseStop };
  const hardDefault =
    entry.direction === 'short' ? (cfg.exit_engine.short_hard_stop_pct ?? baseStop) : baseStop;
  const e = entry.exit;
  return {
    hardStopPct: e?.hardStopPct ?? hardDefault,
    ...(e?.invalidationPrice !== undefined ? { invalidationPrice: e.invalidationPrice } : {}),
    ...(e?.target !== undefined ? { target: e.target } : {}),
    ...(e?.trail ? { trail: e.trail } : {}),
    timeStopHours: e?.timeStopHours ?? cfg.exit_engine.horizon_hours[entry.horizon ?? 'days'],
  };
}

// Sanity ceilings for LLM-emitted values: a stop or trail beyond 50% or a
// time stop beyond ~6 weeks is not a level, it's a hallucination — drop it and
// let the deterministic fallback cover the field.
const MAX_LLM_STOP_PCT = 50;
const MAX_LLM_TIME_STOP_HOURS = 1008; // 6 weeks

/**
 * Direction-aware validation of a raw LLM exit block (snake_case fields from
 * the narrative tool schema). Every field is independently validated against
 * the entry limit band; anything malformed or on the wrong side is DROPPED —
 * a wrong-side invalidation level would exit instantly at entry, so rejecting
 * is the fail-safe direction. Returns camelCase partial plan.
 */
export function sanitizeExitPlan(
  raw: unknown,
  direction: 'long' | 'short',
  band: { low: number; high: number },
): Partial<ExitPlan> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
  const isLong = direction === 'long';
  const out: Partial<ExitPlan> = {};

  const hard = num(r.hard_stop_pct);
  if (hard !== undefined && hard <= MAX_LLM_STOP_PCT) out.hardStopPct = hard;

  const inval = num(r.invalidation_price);
  // Thesis-death level must sit on the LOSING side of every admissible entry.
  if (inval !== undefined && (isLong ? inval < band.low : inval > band.high)) {
    out.invalidationPrice = inval;
  }

  const target = num(r.target_price);
  if (target !== undefined && (isLong ? target > band.high : target < band.low)) {
    out.target = target;
  }

  const trailRaw =
    r.trail !== null && typeof r.trail === 'object' && !Array.isArray(r.trail)
      ? (r.trail as Record<string, unknown>)
      : undefined;
  const activatePct = num(trailRaw?.activate_pct);
  const trailPct = num(trailRaw?.trail_pct);
  if (activatePct !== undefined && trailPct !== undefined && trailPct <= MAX_LLM_STOP_PCT) {
    out.trail = { activatePct, trailPct };
  }

  const hours = num(r.time_stop_hours);
  if (hours !== undefined && hours <= MAX_LLM_TIME_STOP_HOURS) out.timeStopHours = hours;

  return out;
}

/** Deterministic fallback filled first, then sanitized LLM fields on top. */
export function mergedExitPlan(
  entry: Pick<ThesisEntry, 'direction' | 'horizon'>,
  llm: Partial<ExitPlan> | undefined,
  cfg: Config,
): ExitPlan {
  return { ...resolveExitPlan(entry, cfg), ...(llm ?? {}) };
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run tests/exits.test.ts`
Expected: PASS (31 tests).

- [ ] **Step 5: Commit**

```bash
git add src/exits.ts tests/exits.test.ts
git commit -m "feat: exit plan resolution, LLM-level sanitization, merge helper"
```

---

## Task 5: Position-peak persistence (`src/state.ts`)

Ticks are independent processes; trailing needs a persisted per-position favorable-peak plus a first-seen entry time. Fidelity rule from the spec: peaks update at tick granularity only, in live AND sim.

**Files:**
- Modify: `src/paths.ts`, `src/state.ts`
- Test: `tests/state.test.ts`

- [ ] **Step 1: Write the failing tests** (append inside `tests/state.test.ts`, which already chdirs to a temp dir and re-imports `state` per test)

```ts
describe('position peaks (exit-engine trailing state)', () => {
  it('first observation creates the record with entryTimeMs = now', () => {
    const rec = state.trackPositionPeak('FSLR', 'short', 222.1, 1000);
    expect(rec).toEqual({ side: 'short', entryTimeMs: 1000, peak: 222.1 });
  });

  it('long peak ratchets up and never down', () => {
    state.trackPositionPeak('GS', 'long', 100, 1000);
    expect(state.trackPositionPeak('GS', 'long', 106, 2000).peak).toBe(106);
    const rec = state.trackPositionPeak('GS', 'long', 103, 3000);
    expect(rec.peak).toBe(106);
    expect(rec.entryTimeMs).toBe(1000); // first-seen time is stable
  });

  it('short peak ratchets DOWN (favorable low-water mark)', () => {
    state.trackPositionPeak('FSLR', 'short', 222, 1000);
    expect(state.trackPositionPeak('FSLR', 'short', 218, 2000).peak).toBe(218);
    expect(state.trackPositionPeak('FSLR', 'short', 220, 3000).peak).toBe(218);
  });

  it('a side flip resets the record (re-opened name starts fresh)', () => {
    state.trackPositionPeak('GS', 'long', 100, 1000);
    const rec = state.trackPositionPeak('GS', 'short', 98, 5000);
    expect(rec).toEqual({ side: 'short', entryTimeMs: 5000, peak: 98 });
  });

  it('prunePositionPeaks clears closed positions only', () => {
    state.trackPositionPeak('GS', 'long', 100, 1000);
    state.trackPositionPeak('FSLR', 'short', 222, 1000);
    state.prunePositionPeaks(['GS']);
    expect(state.trackPositionPeak('GS', 'long', 99, 2000).entryTimeMs).toBe(1000);
    // FSLR was pruned: re-observation starts a fresh record
    expect(state.trackPositionPeak('FSLR', 'short', 222, 9000).entryTimeMs).toBe(9000);
  });

  it('a corrupt peaks file degrades to empty state, never throws', () => {
    fs.mkdirSync(path.join(dir, 'out'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'out', 'position-peaks.json'), '{{{');
    expect(state.trackPositionPeak('GS', 'long', 100, 1000).peak).toBe(100);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/state.test.ts`
Expected: FAIL — `trackPositionPeak` is not a function.

- [ ] **Step 3: Implement**

In `src/paths.ts`, after `peakPath`:

```ts
/** Per-position favorable-peak state for the exit engine's trailing stop
 *  (ticker -> { side, entryTimeMs, peak }); cleared as positions close. */
export const peaksPath = () => path.join(OUT_DIR, 'position-peaks.json');
```

In `src/state.ts`: extend the import to `import { peakPath, peaksPath, statePath, writeJsonAtomic, readJsonIfExists } from './paths.js';` and append:

```ts
export interface PositionPeak {
  side: 'long' | 'short';
  /** First tick that observed the position — conservative entry-time fallback
   *  (underestimates holding time, so a time stop can only fire LATER). */
  entryTimeMs: number;
  /** Favorable extreme since entry: high for longs, low for shorts. */
  peak: number;
}
type PeaksState = Record<string, PositionPeak>;

function readPeaks(): PeaksState {
  try {
    const raw = readJsonIfExists<PeaksState>(peaksPath());
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {}; // corrupt trailing state degrades to fresh, never blocks a tick
  }
}

/**
 * Read-update-write the favorable peak for one position at tick granularity
 * (the spec's fidelity rule: live and sim share this approximation). A side
 * flip or an unseen ticker starts a fresh record keyed to this tick's time.
 */
export function trackPositionPeak(
  ticker: string,
  side: 'long' | 'short',
  mark: number,
  nowMs: number,
): PositionPeak {
  const peaks = readPeaks();
  const key = ticker.toUpperCase();
  const prev = peaks[key];
  const rec: PositionPeak =
    prev && prev.side === side
      ? {
          side,
          entryTimeMs: prev.entryTimeMs,
          peak: side === 'long' ? Math.max(prev.peak, mark) : Math.min(prev.peak, mark),
        }
      : { side, entryTimeMs: nowMs, peak: mark };
  peaks[key] = rec;
  writeJsonAtomic(peaksPath(), peaks);
  return rec;
}

/** Drop peak records for tickers no longer held (position closed). */
export function prunePositionPeaks(openTickers: string[]): void {
  const peaks = readPeaks();
  const open = new Set(openTickers.map((t) => t.toUpperCase()));
  let changed = false;
  for (const key of Object.keys(peaks)) {
    if (!open.has(key)) {
      delete peaks[key];
      changed = true;
    }
  }
  if (changed) writeJsonAtomic(peaksPath(), peaks);
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run tests/state.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/paths.ts src/state.ts tests/state.test.ts
git commit -m "feat: persisted per-position favorable peak for trailing exits"
```

---

## Task 6: Levels from the synthesizer — horizon, narrative schema, pipeline merge

**Files:**
- Modify: `src/synthesis.ts` (dominant horizon), `src/agents/narrative.ts` (schema + sanitize), `src/agents/prompts.ts` (instructions), `src/pipeline.ts` (merge)
- Test: `tests/synthesis.test.ts` (horizon), new `tests/narrative.test.ts`

- [ ] **Step 1: Failing test — dominant horizon** (append to `tests/synthesis.test.ts`, matching its existing fixture style for verdicts/marketInfo/account/cfg; reuse the file's existing helpers for building verdicts if present, else this standalone block)

```ts
describe('computeThesisEntries: dominant horizon', () => {
  it('carries the majority horizon of the agreeing verdicts onto the entry', () => {
    const cfg = ConfigSchema.parse({ conviction_threshold: 0.5, quorum: 2, min_agreeing: 2 });
    const verdicts: Verdict[] = [
      { analyst: 'fundamental', ticker: 'GS', direction: 'long', conviction: 0.9, horizon: 'weeks', evidence: [], invalidation_conditions: [] },
      { analyst: 'sentiment', ticker: 'GS', direction: 'long', conviction: 0.9, horizon: 'weeks', evidence: [], invalidation_conditions: [] },
      { analyst: 'technical', ticker: 'GS', direction: 'long', conviction: 0.8, horizon: 'days', evidence: [], invalidation_conditions: [] },
    ];
    const marketInfo = new Map([['GS', { lastPrice: 100, avgDollarVolume20d: 5e7 }]]);
    const account = { equity: 100000, cash: 100000, positions: [] };
    const { entries } = computeThesisEntries(verdicts, marketInfo, account, cfg);
    expect(entries[0]?.horizon).toBe('weeks');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/synthesis.test.ts`
Expected: FAIL — `horizon` is undefined on the entry.

- [ ] **Step 3: Implement horizon in `src/synthesis.ts`**

In `computeThesisEntries`, right before `entries.push({`:

```ts
    // Dominant verdict horizon of the agreeing analysts (strict majority for
    // 'weeks', else 'days') — feeds the exit engine's time-stop fallback.
    const weeksVotes = agreeing.filter((v) => v.horizon === 'weeks').length;
    const horizon: 'days' | 'weeks' = weeksVotes * 2 > agreeing.length ? 'weeks' : 'days';
```

and add `horizon,` to the pushed object (after `weightedConviction,`).

Run: `pnpm vitest run tests/synthesis.test.ts` — expected PASS.

- [ ] **Step 4: Failing test — narrative exit emission**

Create `tests/narrative.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { callStructured } from '../src/agents/llm.js';
import { writeNarratives, type ComputedEntry } from '../src/agents/narrative.js';
import { ConfigSchema } from '../src/config.js';
import type { Verdict } from '../src/types.js';

vi.mock('../src/agents/llm.js', () => ({ callStructured: vi.fn() }));
const mock = callStructured as unknown as Mock;

const cfg = ConfigSchema.parse({});
const entry: ComputedEntry = {
  ticker: 'GS',
  direction: 'long',
  weightedConviction: 0.7,
  limitBand: { low: 97, high: 101 },
  targetNotionalUsd: 1000,
  invalidationConditions: ['computed condition'],
  horizon: 'days',
};
const verdicts: Verdict[] = [
  {
    analyst: 'fundamental',
    ticker: 'GS',
    direction: 'long',
    conviction: 0.8,
    horizon: 'days',
    evidence: ['beat'],
    invalidation_conditions: ['guidance walk-back'],
  },
];

beforeEach(() => mock.mockReset());

describe('writeNarratives exit emission', () => {
  it('passes through a sanitized structured exit block', async () => {
    mock.mockResolvedValueOnce({
      narratives: [
        {
          ticker: 'GS',
          narrative: 'A cohesive narrative.',
          invalidation_conditions: ['guidance walk-back'],
          exit: { invalidation_price: 95, target_price: 112, time_stop_hours: 48 },
        },
      ],
    });
    const out = await writeNarratives(cfg, [entry], verdicts);
    expect(out.get('GS')?.exit).toEqual({ invalidationPrice: 95, target: 112, timeStopHours: 48 });
  });

  it('drops wrong-side levels but keeps the narrative', async () => {
    mock.mockResolvedValueOnce({
      narratives: [
        {
          ticker: 'GS',
          narrative: 'A cohesive narrative.',
          invalidation_conditions: [],
          exit: { invalidation_price: 150, target_price: 90 }, // both wrong side for a long
        },
      ],
    });
    const out = await writeNarratives(cfg, [entry], verdicts);
    expect(out.get('GS')?.narrative).toBe('A cohesive narrative.');
    expect(out.get('GS')?.exit).toBeUndefined();
  });

  it('LLM failure falls back with no exit block', async () => {
    mock.mockRejectedValueOnce(new Error('api down'));
    const out = await writeNarratives(cfg, [entry], verdicts);
    expect(out.get('GS')?.exit).toBeUndefined();
    expect(out.get('GS')?.narrative).toContain('beat');
  });
});
```

Run: `pnpm vitest run tests/narrative.test.ts`
Expected: FAIL — `exit` is undefined on the first test (schema/parse not implemented).

- [ ] **Step 5: Implement narrative emission**

In `src/agents/narrative.ts`:

1. Add imports: `import { sanitizeExitPlan } from '../exits.js';` and `import type { ExitPlan } from '../types.js';`
2. Extend `NarrativeResult`:

```ts
export interface NarrativeResult {
  narrative: string;
  invalidationConditions: string[];
  /** Sanitized structured exit levels; absent when the LLM emitted none that survived validation. */
  exit?: Partial<ExitPlan>;
}
```

3. In `NARRATIVE_SCHEMA`, add to the item `properties` (after `invalidation_conditions`):

```ts
          exit: {
            type: 'object',
            description:
              'Structured exit levels translated from the stated invalidation conditions and evidence. Omit any field the verdicts do not support.',
            properties: {
              hard_stop_pct: {
                type: 'number',
                description: 'Worst-case loss percent for this position; omit to use the desk default',
              },
              invalidation_price: {
                type: 'number',
                description:
                  'Numeric thesis-death price (long: strictly below the entry band; short: strictly above)',
              },
              target_price: {
                type: 'number',
                description: 'Take-profit price (long: above the entry band; short: below)',
              },
              trail: {
                type: 'object',
                properties: {
                  activate_pct: { type: 'number', description: 'Arm trailing once unrealized gain reaches this percent' },
                  trail_pct: { type: 'number', description: 'Exit on this percent retrace from the favorable peak' },
                },
                required: ['activate_pct', 'trail_pct'],
                additionalProperties: false,
              },
              time_stop_hours: {
                type: 'number',
                description: 'Exit if unresolved this many hours after entry, consistent with the verdict horizon',
              },
            },
            additionalProperties: false,
          },
```

(`exit` stays OUT of the item's `required` list.)

4. In the parse loop, after `const merged = stringArray(record.invalidation_conditions);` add:

```ts
        const exit = sanitizeExitPlan(record.exit, entry.direction, entry.limitBand);
```

and extend the `out.set(ticker, { ... })` object with:

```ts
          ...(Object.keys(exit).length > 0 ? { exit } : {}),
```

5. In `src/agents/prompts.ts`, extend `SYNTH_NARRATIVE_SYSTEM` — replace the final sentence (`Never invent data ... one item per ticker.`) with:

```ts
Also translate the panel's stated levels into a structured exit block per ticker: invalidation_price is the numeric price at which the thesis is dead (long: strictly below the entry band; short: strictly above), target_price a take-profit consistent with the evidence, time_stop_hours a holding horizon consistent with the verdicts' stated horizon, and trail only when the thesis is explicitly momentum-shaped. Emit only fields the verdicts actually ground — omissions are covered by deterministic desk defaults, and any level on the wrong side of the entry band is discarded.

Never invent data or introduce claims not present in the verdicts. Submit through the submit_narratives tool with one item per ticker.`;
```

Run: `pnpm vitest run tests/narrative.test.ts` — expected PASS.

- [ ] **Step 6: Merge into the thesis in `src/pipeline.ts`**

Add import: `import { mergedExitPlan } from './exits.js';`

Replace the entries-assembly map:

```ts
  const entries: ThesisEntry[] = computed.entries.map((entry) => {
    const n = narratives.get(entry.ticker);
    return {
      ...entry,
      narrative: n?.narrative ?? '',
      invalidationConditions: n?.invalidationConditions ?? entry.invalidationConditions,
      // Structured exit plan: deterministic fallback (config hard stop +
      // horizon time-stop) with sanitized LLM levels on top. Emitted
      // unconditionally — enforcement is gated by exit_engine.enabled, so
      // on/off sweep cells share byte-identical LLM inputs AND thesis files.
      exit: mergedExitPlan(entry, n?.exit, cfg),
    };
  });
```

- [ ] **Step 7: Run the full suite**

Run: `pnpm test 2>&1 | tail -3`
Expected: all pass (replay test still green — the narrative fixture path returns no `exit`, which merges to fallback-only plans).

- [ ] **Step 8: Commit**

```bash
git add src/synthesis.ts src/agents/narrative.ts src/agents/prompts.ts src/pipeline.ts tests/synthesis.test.ts tests/narrative.test.ts
git commit -m "feat: synthesizer emits structured exit levels with deterministic fallback"
```

---## Task 7: Executor integration — engine enforcement, judge overlay, native stop leg

**Files:**
- Modify: `src/executor-loop.ts`
- Test: new `tests/executor-exit-engine.test.ts`

- [ ] **Step 1: Write the failing integration tests**

Create `tests/executor-exit-engine.test.ts`:

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { ConfigSchema, type Config } from '../src/config.js';
import type {
  AccountSnapshot,
  BrokerOrder,
  ProposedOrder,
  QuoteSnapshot,
  Thesis,
} from '../src/types.js';
import type { BrokerClient } from '../src/broker/client.js';
import type { AlpacaMarketData } from '../src/broker/marketdata.js';

vi.mock('../src/agents/judge.js', () => ({ judgeTick: vi.fn() }));

// paths.ts resolves OUT_DIR from process.cwd() at import time, so each test
// chdirs into a fresh temp dir and re-imports the executor module graph.
let runTick: (typeof import('../src/executor-loop.js'))['runTick'];
let judgeTick: Mock;
let dir: string;
const originalCwd = process.cwd();

// 2026-07-15 is a Wednesday; 13:00Z = 09:00 ET = premarket, entries allowed (>= 08:00).
const NOW = new Date('2026-07-15T13:00:00Z');
const YMD = '2026-07-15';

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offhours-exit-engine-'));
  process.chdir(dir);
  fs.mkdirSync(path.join(dir, 'out'), { recursive: true });
  vi.resetModules();
  const judge = await import('../src/agents/judge.js');
  judgeTick = judge.judgeTick as unknown as Mock;
  judgeTick.mockReset();
  ({ runTick } = await import('../src/executor-loop.js'));
});

afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(dir, { recursive: true, force: true });
});

function baseCfg(): Config {
  return ConfigSchema.parse({ mode: 'paper' });
}

function writeThesis(thesis: Thesis, kind: 'offhours' | 'rth' = 'offhours'): void {
  const file = path.join(
    dir,
    'out',
    kind === 'rth' ? `thesis-${thesis.date}-rth.json` : `thesis-${thesis.date}.json`,
  );
  fs.writeFileSync(file, JSON.stringify(thesis));
}

function quote(ticker: string, bid: number, ask: number): QuoteSnapshot {
  return { ticker, bid, ask, bidSize: 500, askSize: 500, last: (bid + ask) / 2, asOf: NOW.toISOString() };
}

function fakeBroker(account: AccountSnapshot, placed: ProposedOrder[]): BrokerClient {
  return {
    getAccount: async () => account,
    getOpenOrders: async () => [],
    getTodayOrders: async () => [],
    getDailyPl: async () => 0,
    cancelOrdersFor: async () => {},
    getAsset: async () => ({ shortable: true, easyToBorrow: true }),
    placeLimitOrder: async (o: ProposedOrder): Promise<BrokerOrder> => {
      placed.push(o);
      return {
        id: `o-${placed.length}`,
        ticker: o.ticker,
        side: o.side,
        qty: o.qty,
        limitPrice: o.limitPrice,
        status: 'accepted',
        submittedAt: NOW.toISOString(),
        clientOrderId: `${o.intent}-test`,
        filledQty: 0,
      };
    },
  } as unknown as BrokerClient;
}

function fakeMd(quotes: QuoteSnapshot[]): AlpacaMarketData {
  return {
    getLatestQuotes: async () => quotes,
    getNews: async () => [],
  } as unknown as AlpacaMarketData;
}

const shortPosition = {
  ticker: 'FSLR',
  qty: 4,
  avgEntryPrice: 222.23,
  marketValue: -888,
  unrealizedPl: 10,
  side: 'short' as const,
};

function fslrThesis(exit: Record<string, unknown>): Thesis {
  return {
    date: YMD,
    kind: 'offhours',
    generatedAt: '2026-07-14T21:05:00.000Z',
    expiresAt: '2026-07-16T00:00:00.000Z',
    entries: [
      {
        ticker: 'FSLR',
        direction: 'short',
        weightedConviction: 0.6,
        limitBand: { low: 218, high: 228 },
        targetNotionalUsd: 900,
        narrative: 'momentum short',
        invalidationConditions: ['closes above 232'],
        horizon: 'days',
        exit: exit as never,
      },
    ],
    skipped: [],
  };
}

describe('executor exit engine', () => {
  it('time_stop exits a held position without consulting the judge', async () => {
    writeThesis(fslrThesis({ hardStopPct: 8, timeStopHours: 1 }));
    // Seed the peak state: first seen 2h ago.
    fs.writeFileSync(
      path.join(dir, 'out', 'position-peaks.json'),
      JSON.stringify({
        FSLR: { side: 'short', entryTimeMs: NOW.getTime() - 2 * 3_600_000, peak: 220 },
      }),
    );
    const placed: ProposedOrder[] = [];
    await runTick({
      cfg: baseCfg(),
      now: NOW,
      broker: fakeBroker({ equity: 100000, cash: 100000, positions: [shortPosition] }, placed),
      marketData: fakeMd([quote('FSLR', 219.0, 219.1)]),
      llm: {} as never,
    });
    expect(placed).toHaveLength(1);
    expect(placed[0]).toMatchObject({ ticker: 'FSLR', side: 'buy', qty: 4, intent: 'exit' });
    expect(placed[0]!.reason).toContain('time_stop');
    expect(judgeTick).not.toHaveBeenCalled();
    const audit = fs.readFileSync(path.join(dir, 'out', `audit-${YMD}.jsonl`), 'utf8');
    expect(audit).toContain('"trigger":"time_stop"');
  });

  it('judge overlay runs only when the engine abstains, and its exit is attributed to judge', async () => {
    writeThesis(fslrThesis({ hardStopPct: 8, timeStopHours: 240 }));
    judgeTick.mockResolvedValue({ proceed: false, exitPosition: true, reasons: ['stated invalidation triggered'] });
    const placed: ProposedOrder[] = [];
    await runTick({
      cfg: baseCfg(),
      now: NOW,
      broker: fakeBroker({ equity: 100000, cash: 100000, positions: [shortPosition] }, placed),
      marketData: fakeMd([quote('FSLR', 219.0, 219.1)]),
      llm: {} as never,
    });
    expect(judgeTick).toHaveBeenCalledTimes(1);
    expect(placed).toHaveLength(1);
    expect(placed[0]!.intent).toBe('exit');
    const audit = fs.readFileSync(path.join(dir, 'out', `audit-${YMD}.jsonl`), 'utf8');
    expect(audit).toContain('"trigger":"judge"');
  });

  it('exit_engine.enabled=false reproduces the legacy static-stop path', async () => {
    writeThesis(fslrThesis({ hardStopPct: 2, timeStopHours: 1 })); // would fire under the engine
    const cfg = baseCfg();
    cfg.exit_engine.enabled = false;
    judgeTick.mockResolvedValue({ proceed: false, exitPosition: false, reasons: [] });
    const placed: ProposedOrder[] = [];
    await runTick({
      cfg,
      now: NOW,
      broker: fakeBroker({ equity: 100000, cash: 100000, positions: [shortPosition] }, placed),
      marketData: fakeMd([quote('FSLR', 219.0, 219.1)]),
      llm: {} as never,
    });
    // Short is in profit (mark 219.1 < entry 222.23): legacy stop does not fire,
    // judge declines to exit -> nothing placed, engine plan ignored.
    expect(placed).toHaveLength(0);
  });

  it('starved exit check is audited when a held thesis position has no quote', async () => {
    writeThesis(fslrThesis({ hardStopPct: 8, timeStopHours: 1 }));
    const placed: ProposedOrder[] = [];
    await runTick({
      cfg: baseCfg(),
      now: NOW,
      broker: fakeBroker({ equity: 100000, cash: 100000, positions: [shortPosition] }, placed),
      marketData: fakeMd([]), // market dark
      llm: {} as never,
    });
    expect(placed).toHaveLength(0);
    const audit = fs.readFileSync(path.join(dir, 'out', `audit-${YMD}.jsonl`), 'utf8');
    expect(audit).toContain('"stage":"exit_starved"');
  });

  it('RTH entry carries a native stop leg at the resolved plan hard stop', async () => {
    const rthNow = new Date('2026-07-15T15:00:00Z'); // 11:00 ET, inside RTH
    const thesis: Thesis = {
      date: YMD,
      kind: 'rth',
      generatedAt: '2026-07-15T13:00:00.000Z',
      expiresAt: '2026-07-15T20:00:00.000Z',
      entries: [
        {
          ticker: 'GS',
          direction: 'long',
          weightedConviction: 0.6,
          limitBand: { low: 97, high: 103 },
          targetNotionalUsd: 1000,
          narrative: 'earnings re-rating',
          invalidationConditions: [],
          horizon: 'days',
          exit: { hardStopPct: 4, timeStopHours: 30 },
        },
      ],
      skipped: [],
    };
    writeThesis(thesis, 'rth');
    const cfg = baseCfg();
    cfg.sessions.regularhours = true;
    judgeTick.mockResolvedValue({ proceed: true, exitPosition: false, reasons: ['holds'] });
    const placed: ProposedOrder[] = [];
    await runTick({
      cfg,
      now: rthNow,
      broker: fakeBroker({ equity: 100000, cash: 100000, positions: [] }, placed),
      marketData: fakeMd([
        { ticker: 'GS', bid: 99.9, ask: 100, bidSize: 500, askSize: 500, last: 100, asOf: rthNow.toISOString() },
      ]),
      llm: {} as never,
    });
    expect(placed).toHaveLength(1);
    // limit 100 (marketable ask, inside band); stop = 100 * (1 - 4/100) = 96
    expect(placed[0]!.stopLoss).toBe(96);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/executor-exit-engine.test.ts`
Expected: FAIL — no `trigger` in exit audits, judge called in test 1, no `exit_starved` stage, stopLoss = 92 (from `max_position_loss_pct` 8) in the last test.

- [ ] **Step 3: Integrate the engine in `src/executor-loop.ts`**

Add imports:

```ts
import { evaluateExit, resolveExitPlan } from './exits.js';
```

and extend the state import to:

```ts
import { prunePositionPeaks, readHaltState, trackPositionPeak, updatePeakEquity, writeHalt } from './state.js';
```

Replace the no-quote branch of the exits loop (`if (!quote) { ... continue; }`) with:

```ts
    if (!quote) {
      if (entry) {
        skip(ticker, 'no quote for exit check');
        // Operator visibility: an exit-worthy position the market has gone
        // dark on (e.g. off-hours with no SIP print). Triggers re-evaluate on
        // the next tick that has a fresh quote.
        appendAudit({ kind: 'tick', data: { stage: 'exit_starved', ticker, session } });
      } else {
        appendAudit({
          kind: 'tick',
          data: { stage: 'orphan_position', ticker, note: 'no quote; stop-only monitoring' },
        });
      }
      continue;
    }
```

Replace the block from `const isLong = position.side === 'long';` through the end of the `else` orphan branch (currently ending `continue; }` just before `if (!exitReasons) continue;`) with:

```ts
    const isLong = position.side === 'long';
    const mark = isLong ? quote.bid : quote.ask;
    let exitReasons: string[] | null = null;
    let trigger: string | undefined;
    if (cfg.exit_engine.enabled) {
      // Deterministic engine first (orphans run a stop-only plan — no thesis
      // horizon, no judge: today's protection exactly). The judge is a
      // qualitative overlay consulted only when the engine abstains.
      const plan = entry ? resolveExitPlan(entry, cfg) : resolveExitPlan(undefined, cfg);
      const peak = trackPositionPeak(ticker, position.side, mark, now.getTime());
      const decision = evaluateExit({
        direction: position.side,
        entryPrice: position.avgEntryPrice,
        entryTimeMs: peak.entryTimeMs,
        markPrice: mark,
        peakFavorablePrice: peak.peak,
        nowMs: now.getTime(),
        plan,
      });
      if (decision.exit) {
        exitReasons = [decision.reason ?? decision.trigger ?? 'exit'];
        trigger = decision.trigger;
      } else if (entry) {
        const judged = await judgeTick(
          cfg,
          { entry, quote, headlines: headlinesFor(ticker), position },
          deps.llm,
        );
        if (judged.exitPosition) {
          exitReasons = judged.reasons;
          trigger = 'judge';
        }
      } else {
        appendAudit({
          kind: 'tick',
          data: { stage: 'orphan_position', ticker, note: 'stop-only monitoring; no thesis entry to judge' },
        });
        continue;
      }
    } else {
      // Legacy path (exit_engine.enabled=false): static stop + judge,
      // byte-identical to the pre-engine executor. Kept for the paired
      // backtest counterfactual (trial exit-engine-v1).
      const lossPct = positionLossPct(position, quote);
      const stopHit = lossPct >= cfg.max_position_loss_pct;
      if (stopHit) {
        exitReasons = [
          `stop: unrealized loss ${lossPct.toFixed(1)}% >= max_position_loss_pct ${cfg.max_position_loss_pct}%`,
        ];
        trigger = 'hard_stop';
      } else if (entry) {
        const decision = await judgeTick(
          cfg,
          { entry, quote, headlines: headlinesFor(ticker), position },
          deps.llm,
        );
        if (decision.exitPosition) {
          exitReasons = decision.reasons;
          trigger = 'judge';
        }
      } else {
        appendAudit({
          kind: 'tick',
          data: { stage: 'orphan_position', ticker, note: 'stop-only monitoring; no thesis entry to judge' },
        });
        continue;
      }
    }
```

Update the exit audit line to carry the trigger:

```ts
    appendAudit({
      kind: 'exit',
      data: { ticker, reasons: exitReasons, trigger, stop: trigger === 'hard_stop', orphan: !entry },
    });
```

After the exits `for` loop closes (before the entry-blackout block), add:

```ts
  // Trailing state hygiene: drop peak records for names no longer held. Gated
  // on the engine flag so the flag-off path writes no new artifact.
  if (cfg.exit_engine.enabled) {
    prunePositionPeaks(account.positions.map((p) => p.ticker.toUpperCase()));
  }
```

In the entry path, replace the `stopLoss` computation with the resolved plan's hard stop:

```ts
    // Regular-session entries carry a native broker stop-loss (Alpaca executes
    // stops in RTH but not extended hours). Long: stop below entry; short: above.
    // The leg uses the entry's RESOLVED hard stop so the resting broker stop and
    // the tick check agree (falls back to max_position_loss_pct when bare).
    const entryHardStopPct = resolveExitPlan(entry, cfg).hardStopPct;
    const stopLoss =
      session === 'rth'
        ? entry.direction === 'long'
          ? Math.round(limitPrice * (1 - entryHardStopPct / 100) * 100) / 100
          : Math.round(limitPrice * (1 + entryHardStopPct / 100) * 100) / 100
        : undefined;
```

- [ ] **Step 4: Run the integration tests, then the whole suite**

Run: `pnpm vitest run tests/executor-exit-engine.test.ts` — expected PASS (5 tests).
Run: `pnpm test 2>&1 | tail -3` — expected all pass. If `tests/replay.test.ts` or `tests/executor-helpers.test.ts` assert on the old `stop:` reason string, update those assertions to the new `hard_stop:` prefix (engine path) — the legacy path string is unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/executor-loop.ts tests/executor-exit-engine.test.ts
git commit -m "feat: executor enforces the exit engine; judge demoted to overlay"
```

---

## Task 8: Backtest exit-trigger attribution

The episode runner drives the real `runTick`, so the engine already runs in sim. This task makes the report attribute exits by trigger and distinguish a structured `time_stop` from a blind boundary flatten.

**Files:**
- Modify: `scripts/backtest-episode.ts` (exit-event tally + trade rows)
- Modify: `src/backtest/metrics.ts` (pure helpers + report tally)
- Test: `tests/backtest-metrics.test.ts`

- [ ] **Step 1: Write the failing metrics tests** (append to `tests/backtest-metrics.test.ts`)

```ts
describe('exit attribution', () => {
  it('classifies engine triggers, legacy strings, judge, and force-flatten', () => {
    expect(exitTriggerOf('hard_stop: unrealized loss 8.2% >= 8%')).toBe('hard_stop');
    expect(exitTriggerOf('stop: unrealized loss 8.2% >= max_position_loss_pct 8%')).toBe('hard_stop');
    expect(exitTriggerOf('invalidation_price: mark 94 <= 95')).toBe('invalidation_price');
    expect(exitTriggerOf('target: mark 110 >= 110')).toBe('target');
    expect(exitTriggerOf('trail: retrace 2.1% from peak 106 >= 2%')).toBe('trail');
    expect(exitTriggerOf('time_stop: held 30.2h >= 30h')).toBe('time_stop');
    expect(exitTriggerOf('force-flatten')).toBe('force_flatten');
    expect(exitTriggerOf('judge exit: guidance walked back')).toBe('judge');
  });

  it('tallies a breakdown over trades', () => {
    const mk = (exitReason: string) => ({
      ticker: 'X', side: 'long' as const, qty: 1, entryPrice: 1, exitPrice: 1,
      feesUsd: 0, borrowUsd: 0, pnlUsd: 0, analystsAgreeing: [], exitReason,
    });
    expect(exitBreakdown([mk('force-flatten'), mk('force-flatten'), mk('time_stop: held 30h >= 30h')])).toEqual({
      force_flatten: 2,
      time_stop: 1,
    });
  });
});
```

Add `exitTriggerOf, exitBreakdown` to the file's import from `../src/backtest/metrics.js`.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/backtest-metrics.test.ts`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement the pure helpers** (append near `tradeNetUsd` in `src/backtest/metrics.ts`)

```ts
// ---------- exit attribution ----------

const ENGINE_TRIGGERS = ['hard_stop', 'invalidation_price', 'target', 'trail', 'time_stop'] as const;

/** Classify a TradeRow exitReason into its trigger family. Legacy 'stop:' maps
 *  to hard_stop; anything unrecognized is a judge exit (the pre-engine default). */
export function exitTriggerOf(exitReason: string): string {
  if (exitReason === 'force-flatten') return 'force_flatten';
  for (const t of ENGINE_TRIGGERS) {
    if (exitReason === t || exitReason.startsWith(`${t}:`)) return t;
  }
  if (exitReason.startsWith('stop:')) return 'hard_stop';
  return 'judge';
}

/** Count of closed trades per exit trigger family (force-flatten truncation
 *  rate = force_flatten / total — the spec's primary risk-shape metric). */
export function exitBreakdown(trades: EpisodeTrade[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of trades) {
    const k = exitTriggerOf(t.exitReason);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}
```

Run: `pnpm vitest run tests/backtest-metrics.test.ts` — expected PASS.

- [ ] **Step 4: Thread the trigger through the episode runner**

In `scripts/backtest-episode.ts`:

1. Change the tally type (near line 225) from `exitReasonsByTicker: Map<string, string[][]>` to:

```ts
  exitReasonsByTicker: Map<string, { trigger?: string; reasons: string[] }[]>;
```

2. In the audit-event scan (near line 265), replace the exit-event push with:

```ts
    if (e.kind === 'exit' && typeof data?.ticker === 'string') {
      const ticker = data.ticker.toUpperCase();
      const reasons = Array.isArray(data.reasons)
        ? (data.reasons as unknown[]).filter((r): r is string => typeof r === 'string')
        : [];
      const trigger = typeof data.trigger === 'string' ? data.trigger : undefined;
      const queue = exitReasonsByTicker.get(ticker) ?? [];
      queue.push({ trigger, reasons });
      exitReasonsByTicker.set(ticker, queue);
    }
```

3. In `buildTradeRows` (near line 315), replace the reasons shift + `exitReason` assignment with:

```ts
    const rec = exitReasonsByTicker.get(ticker)?.shift();
    const exitReason = rec
      ? rec.trigger && rec.trigger !== 'judge'
        ? rec.reasons.join('; ') || rec.trigger
        : `judge exit: ${rec.reasons.join('; ') || 'judge exit'}`
      : 'judge exit';
```

and use `exitReason` in the row object (replacing the old inline expression). Engine reasons are already prefixed with their trigger (`time_stop: held ...`), so `exitTriggerOf` classifies them without extra plumbing; the boundary flatten still writes the literal `'force-flatten'`.

4. Update the `buildTradeRows` signature's `exitReasonsByTicker` parameter type to match the new tally type.

- [ ] **Step 5: Add the report tally**

Find the report line that prints the flatten count: `grep -n "danglingAtFlatten" src/backtest/metrics.ts`. Immediately after that line in the report renderer, add an exit-attribution block:

```ts
  const breakdown = exitBreakdown(episodes.flatMap((e) => e.trades));
  const totalClosed = Object.values(breakdown).reduce((a, b) => a + b, 0);
  lines.push('', '### Exit attribution', '');
  lines.push('| trigger | trades | share |', '|---|---|---|');
  for (const [k, v] of Object.entries(breakdown).sort((a, b) => b[1] - a[1])) {
    lines.push(`| ${k} | ${v} | ${totalClosed > 0 ? ((100 * v) / totalClosed).toFixed(1) : '0.0'}% |`);
  }
  lines.push('', `Force-flatten truncation rate: ${totalClosed > 0 ? ((100 * (breakdown.force_flatten ?? 0)) / totalClosed).toFixed(1) : '0.0'}% of closed trades.`);
```

Adapt the two identifiers to the renderer's local names (the accumulator is the `lines`/`out` array the surrounding code pushes report rows into; the episode list is the variable the `danglingAtFlatten` line reads from). Everything else lands verbatim.

- [ ] **Step 6: Run the backtest-adjacent suites**

Run: `pnpm vitest run tests/backtest-metrics.test.ts tests/backtest-driver.test.ts tests/backtest-sweep.test.ts`
Expected: PASS. If a driver test asserts on the old `judge exit:` prefix for engine-triggered exits, update it to the bare trigger-prefixed string.

- [ ] **Step 7: Commit**

```bash
git add scripts/backtest-episode.ts src/backtest/metrics.ts tests/backtest-metrics.test.ts
git commit -m "feat: exit-trigger attribution in backtest trades and report"
```

---

## Task 9: Paired guardrail sweep cell (engine ON vs OFF)

**Files:**
- Modify: `scripts/backtest.ts` (`signalToggleCells`)
- Test: `tests/backtest-sweep.test.ts`

- [ ] **Step 1: Write the failing test** (append to `tests/backtest-sweep.test.ts`, importing `signalToggleCells, cellConfig` and `ConfigSchema` as the file already does or adding them)

```ts
describe('exit-engine guardrail cell', () => {
  it('adds a paired cell that turns the engine OFF against the default-on baseline', () => {
    const cells = signalToggleCells();
    const cell = cells.find((c) => c.id === 'guardrail-exit-engine-off');
    expect(cell).toBeDefined();
    expect(cell!.flag).toBe('exit_engine');
    const cfg = cellConfig(ConfigSchema.parse({}), cell!);
    expect(cfg.exit_engine.enabled).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/backtest-sweep.test.ts`
Expected: FAIL — cell not found.

- [ ] **Step 3: Implement**

In `scripts/backtest.ts`, extend `signalToggleCells`:

```ts
export function signalToggleCells(threshold = 0.55, bearWeight = 1.2): SweepCell[] {
  return [
    { id: 'baseline', threshold, bearWeight },
    ...SIGNAL_ENABLERS.map((e) => ({ id: `sig-${e.flag}`, threshold, bearWeight, flag: e.flag, patch: e.patch })),
    // Paired guardrail cell (trial exit-engine-v1): the default config ships the
    // exit engine ON, so this cell turns it OFF. Same entries, same cached LLM
    // inputs — the paired difference isolates the engine's risk-shape effect
    // (drawdown / book vol / force-flatten truncation), never an edge claim.
    {
      id: 'guardrail-exit-engine-off',
      threshold,
      bearWeight,
      flag: 'exit_engine',
      patch: (c) => ({ ...c, exit_engine: { ...c.exit_engine, enabled: false } }),
    },
  ];
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run tests/backtest-sweep.test.ts tests/trial-registry.test.ts`
Expected: `backtest-sweep` PASS. If any existing test pins the exact cell count of `signalToggleCells()`, bump it by one. `trial-registry` may FAIL on the unknown `exit_engine` flag — that is Task 10.

- [ ] **Step 5: Commit**

```bash
git add scripts/backtest.ts tests/backtest-sweep.test.ts
git commit -m "feat: paired exit-engine on/off sweep cell"
```

---

## Task 10: Trial-registry guardrail row

**Files:**
- Modify: `trial-registry.yaml`, `docs/TRIAL-REGISTRY.md`

- [ ] **Step 1: Append the row from the spec (§9) to `trial-registry.yaml`**

```yaml
- id: exit-engine-v1
  date: "2026-07-15"
  window: "2026-01-01..2026-07-01"
  flag: exit_engine
  type: guardrail
  status: pre-registered
  notes: >-
    Deterministic thesis-grounded exit engine (hard stop / invalidation price /
    target / trail / time-stop), all-or-nothing, tick-enforced + native RTH
    hard-stop leg. Guardrail: no new entry signal. Measured by paired
    counterfactual on identical entries & realized fills — risk-shape claim
    (drawdown / book vol / force-flatten-truncation rate), NOT edge. Any
    mean-P&L effect is soak-scrutinized like alpha.
```

Match the file's existing row formatting (inspect the last row first: `tail -20 trial-registry.yaml`).

- [ ] **Step 2: Add the matching row to `docs/TRIAL-REGISTRY.md`**, following that file's table/format conventions (inspect first: `tail -30 docs/TRIAL-REGISTRY.md`). Content: id `exit-engine-v1`, type guardrail, status pre-registered, one-line summary "deterministic exit engine; paired counterfactual; risk-shape claim only".

- [ ] **Step 3: Run the registry tests**

Run: `pnpm vitest run tests/trial-registry.test.ts`
Expected: PASS (guardrail rows are exempt from the mechanism gate per the registry rules).

- [ ] **Step 4: Commit**

```bash
git add trial-registry.yaml docs/TRIAL-REGISTRY.md
git commit -m "docs: pre-register exit-engine-v1 guardrail trial"
```

---

## Task 11: `macro_event_blackout` config + seeded calendar

**Files:**
- Modify: `src/config.ts`, `config.yaml`
- Test: `tests/config.test.ts`

- [ ] **Step 1: Write the failing config test** (append to `tests/config.test.ts`)

```ts
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
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/config.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add the schema block** (in `src/config.ts`, after the `entry_blackout` block)

```ts
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
```

Add `'macro_event_blackout'` to the `saveConfig` nested-merge key list.

Run: `pnpm vitest run tests/config.test.ts` — expected PASS.

- [ ] **Step 4: Verify release dates from the primary sources, then seed `config.yaml`**

Fetch the official schedules (do not trust memory for dates):

```bash
curl -s https://www.bls.gov/schedule/news_release/cpi.htm | grep -Eo '(January|February|March|April|May|June|July|August|September|October|November|December)\.? [0-9]{1,2}, 2026' | head -12
curl -s https://www.bls.gov/schedule/news_release/empsit.htm | grep -Eo '(January|February|March|April|May|June|July|August|September|October|November|December)\.? [0-9]{1,2}, 2026' | head -12
curl -s https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm | grep -Eio '(january|february|march|april|may|june|july|august|september|october|november|december)[^<]{0,20}2026' | head -20
```

Then append to `config.yaml` (after the `entry_blackout` block) with the FETCHED dates — the entries below are the expected shape and the July/August window that matters first; correct every date/time against the fetched schedules and extend through year-end. CPI and payrolls release at 08:30 ET; the FOMC statement lands at 14:00 ET on each meeting's final day.

```yaml
# Entries-only blackout around scheduled binary macro prints (exits never
# gated). Static ET calendar — refresh from bls.gov + federalreserve.gov as
# schedules publish (see docs/RUNBOOK.md). Added 2026-07-15 after the June-CPI
# review: the executor could otherwise enter premarket positions minutes
# before an 08:30 print on a thesis formed at 17:00 the prior evening.
macro_event_blackout:
  enabled: true
  pre_min: 30
  post_min: 15
  events:
    - { date: "2026-07-29", hm: "14:00", label: "FOMC statement" }
    - { date: "2026-08-07", hm: "08:30", label: "Nonfarm payrolls" }
    - { date: "2026-08-12", hm: "08:30", label: "CPI" }
```

- [ ] **Step 5: Confirm the live config still parses**

Run: `pnpm tsx -e "import { loadConfig } from './src/config.js'; console.log(loadConfig().macro_event_blackout.events.length)"`
Expected: prints the number of seeded events (≥ 3), no error. (If `tsx` is not a dependency, use the project's existing script runner: `node --loader ts-node/esm` equivalents are visible in `package.json` scripts — match whatever `pnpm tick` uses.)

- [ ] **Step 6: Commit**

```bash
git add src/config.ts config.yaml tests/config.test.ts
git commit -m "feat: macro-event blackout config with seeded release calendar"
```

---

## Task 12: `activeEventBlackout` pure function

**Files:**
- Modify: `src/session-risk.ts`
- Test: `tests/session-risk.test.ts`

- [ ] **Step 1: Write the failing tests** (append to `tests/session-risk.test.ts`)

```ts
describe('activeEventBlackout', () => {
  const cfg = ConfigSchema.parse({
    macro_event_blackout: {
      enabled: true,
      pre_min: 30,
      post_min: 15,
      events: [{ date: '2026-08-12', hm: '08:30', label: 'CPI' }],
    },
  });
  const minutes = (hm: string) => hmToMinutes(hm);

  it('blocks from pre_min before through post_min after the release', () => {
    expect(activeEventBlackout({ ymd: '2026-08-12', minutes: minutes('08:00') }, cfg)?.label).toBe('CPI');
    expect(activeEventBlackout({ ymd: '2026-08-12', minutes: minutes('08:30') }, cfg)?.label).toBe('CPI');
    expect(activeEventBlackout({ ymd: '2026-08-12', minutes: minutes('08:44') }, cfg)?.label).toBe('CPI');
  });

  it('is open just outside the window', () => {
    expect(activeEventBlackout({ ymd: '2026-08-12', minutes: minutes('07:59') }, cfg)).toBeNull();
    expect(activeEventBlackout({ ymd: '2026-08-12', minutes: minutes('08:45') }, cfg)).toBeNull();
  });

  it('ignores other dates, disabled gate, and an empty calendar', () => {
    expect(activeEventBlackout({ ymd: '2026-08-13', minutes: minutes('08:30') }, cfg)).toBeNull();
    const off = ConfigSchema.parse({
      macro_event_blackout: { enabled: false, events: [{ date: '2026-08-12', hm: '08:30', label: 'CPI' }] },
    });
    expect(activeEventBlackout({ ymd: '2026-08-12', minutes: minutes('08:30') }, off)).toBeNull();
    expect(activeEventBlackout({ ymd: '2026-08-12', minutes: minutes('08:30') }, ConfigSchema.parse({}))).toBeNull();
  });
});
```

Add `activeEventBlackout` (and `ConfigSchema` if absent) to the test file's imports.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/session-risk.test.ts`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement** (append to `src/session-risk.ts`)

```ts
export interface MacroEvent {
  date: string;
  hm: string;
  label: string;
}

/**
 * The scheduled macro event whose blackout window covers this ET instant, or
 * null. Window: [release - pre_min, release + post_min). Purely a function of
 * the ET clock and config — no market data, identical on IEX and SIP. ENTRIES
 * ONLY: exits must never be gated by this (same contract as entryTimingAllowed).
 * US macro releases all land well inside a single ET calendar day, so windows
 * never straddle midnight.
 */
export function activeEventBlackout(
  et: { ymd: string; minutes: number },
  cfg: Pick<Config, 'macro_event_blackout'>,
): MacroEvent | null {
  const b = cfg.macro_event_blackout;
  if (!b.enabled) return null;
  for (const ev of b.events) {
    if (ev.date !== et.ymd) continue;
    const t = hmToMinutes(ev.hm);
    if (et.minutes >= t - b.pre_min && et.minutes < t + b.post_min) return ev;
  }
  return null;
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run tests/session-risk.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/session-risk.ts tests/session-risk.test.ts
git commit -m "feat: activeEventBlackout — scheduled macro-event window check"
```

---

## Task 13: Executor event-gate wiring + docs

**Files:**
- Modify: `src/executor-loop.ts`, `README.md`, `docs/RUNBOOK.md`
- Test: `tests/executor-exit-engine.test.ts`

- [ ] **Step 1: Write the failing integration test** (append to `tests/executor-exit-engine.test.ts`)

```ts
describe('macro-event entry blackout', () => {
  it('blocks entries inside the window but still places exits', async () => {
    // 09:00 ET on 2026-07-15 with a 09:15 event: inside [08:45, 09:30).
    const thesis = fslrThesis({ hardStopPct: 8, timeStopHours: 1 });
    thesis.entries.push({
      ticker: 'GS',
      direction: 'long',
      weightedConviction: 0.6,
      limitBand: { low: 97, high: 103 },
      targetNotionalUsd: 1000,
      narrative: 'entry candidate',
      invalidationConditions: [],
      horizon: 'days',
      exit: { hardStopPct: 8, timeStopHours: 30 } as never,
    });
    writeThesis(thesis);
    fs.writeFileSync(
      path.join(dir, 'out', 'position-peaks.json'),
      JSON.stringify({
        FSLR: { side: 'short', entryTimeMs: NOW.getTime() - 2 * 3_600_000, peak: 220 },
      }),
    );
    const cfg = baseCfg();
    cfg.macro_event_blackout.events = [{ date: YMD, hm: '09:15', label: 'TEST-EVENT' }];
    const placed: ProposedOrder[] = [];
    await runTick({
      cfg,
      now: NOW,
      broker: fakeBroker({ equity: 100000, cash: 100000, positions: [shortPosition] }, placed),
      marketData: fakeMd([quote('FSLR', 219.0, 219.1), quote('GS', 99.9, 100.0)]),
      llm: {} as never,
    });
    // The FSLR time_stop exit fires; the GS entry is blocked by the event window.
    expect(placed).toHaveLength(1);
    expect(placed[0]).toMatchObject({ ticker: 'FSLR', intent: 'exit' });
    const audit = fs.readFileSync(path.join(dir, 'out', `audit-${YMD}.jsonl`), 'utf8');
    expect(audit).toContain('"stage":"event_blackout"');
    expect(audit).toContain('TEST-EVENT');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/executor-exit-engine.test.ts`
Expected: FAIL — two orders placed (entry not blocked), no `event_blackout` audit.

- [ ] **Step 3: Wire the gate**

In `src/executor-loop.ts`, extend the session-risk import:

```ts
import { activeEventBlackout, entryTimingAllowed, sessionGate } from './session-risk.js';
```

Immediately after the existing entry-blackout block (`if (!entriesAllowedByTiming && thesis.entries.length > 0) { ... }`), add:

```ts
  // Scheduled-event blackout (entries only, like the timing blackout above).
  // A thesis formed at 17:00 yesterday knows nothing about this morning's
  // print; the deterministic calendar keeps the executor from opening risk
  // into a known binary event. Exits above already ran ungated.
  const eventBlock = activeEventBlackout(nowET(now), cfg);
  if (eventBlock && entriesAllowedByTiming && thesis.entries.length > 0) {
    appendAudit({
      kind: 'tick',
      data: {
        stage: 'event_blackout',
        session,
        label: eventBlock.label,
        eventHm: eventBlock.hm,
        action: 'skip_entries',
        count: thesis.entries.length,
      },
    });
  }
```

Change the entry loop's first line from:

```ts
    if (!entriesAllowedByTiming) break; // timing blackout: no new entries this tick
```

to:

```ts
    if (!entriesAllowedByTiming || eventBlock) break; // timing/event blackout: no new entries this tick
```

- [ ] **Step 4: Run the integration tests, then the full suite**

Run: `pnpm vitest run tests/executor-exit-engine.test.ts` — expected PASS (6 tests).
Run: `pnpm test 2>&1 | tail -3` — expected all pass.

- [ ] **Step 5: Document**

1. `README.md` — in the Tuning paragraph's enumeration of config knobs, extend the list with: `structured exit engine (exit_engine), and a macro-event entry blackout calendar (macro_event_blackout)`.
2. `docs/RUNBOOK.md` — append an operations note:

```markdown
## Macro-event calendar refresh (monthly)

`config.yaml -> macro_event_blackout.events` is a static ET calendar. On the
first weekday of each month, refresh it from the primary sources so every
CPI/FOMC/payrolls release through at least the next 60 days is listed:

- CPI: https://www.bls.gov/schedule/news_release/cpi.htm (08:30 ET)
- Employment situation: https://www.bls.gov/schedule/news_release/empsit.htm (08:30 ET)
- FOMC statements: https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm (14:00 ET, final meeting day)

An empty or stale calendar simply provides no gate on unlisted dates — the
executor logs `event_blackout` skips only for dates that are present.
```

- [ ] **Step 6: Commit**

```bash
git add src/executor-loop.ts tests/executor-exit-engine.test.ts README.md docs/RUNBOOK.md
git commit -m "feat: entries-only blackout around scheduled macro events"
```

---

## Final verification

- [ ] **Step 1: Full suite + typecheck**

Run: `pnpm test 2>&1 | tail -5` — expected: all files pass, 0 failures.
Run: `pnpm exec tsc --noEmit` (or the project's typecheck script if `package.json` defines one) — expected: clean.

- [ ] **Step 2: One dry executor tick against the real config**

Run: `pnpm tick`
Expected: exits/entries behave per session; audit shows `exit_starved` only when quotes are missing; no thrown errors. Inspect: `tail -5 out/audit-$(date +%F).jsonl`.

- [ ] **Step 3: Paired backtest cell (measurement, can run async after landing)**

Run the sweep with the new cell over the registered window and regenerate the report (`scripts/backtest.ts sweep --tag exit-engine-v1 ...` per `docs/QUANT-TESTING-PLAN.md` conventions). Record the §9 metrics (net P&L/trade, book vol, max drawdown, force-flatten truncation rate) as paired differences with `bootstrapCi`, design-weighted. Update the `exit-engine-v1` registry row status per the outcome. Reminder: risk-shape claim only; any mean-P&L improvement stays under the "backtest disproves only" banner.
