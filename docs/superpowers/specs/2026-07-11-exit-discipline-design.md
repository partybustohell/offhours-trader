# Exit discipline — design spec

Date: 2026-07-11. Status: approved design, pre-implementation.
Scope: the position-exit path only. The educated short/sell-side research
capability is a separate spec (sequenced after this one).

## 1. Context & problem

Today's exit path (`src/executor-loop.ts`, the per-position block ~285–366) has
exactly three mechanical exits and one LLM exit:

- **One static hard stop**: `unrealizedLossPct >= max_position_loss_pct`
  (config default 8%), the same level for every position, checked each tick.
- **LLM judge invalidation**: `judge.exitPosition` — the model reads the prose
  `invalidationConditions` and decides if one triggered.
- **Thesis expiry** and, in the backtest, an **episode-boundary force-flatten**
  at D+1 20:00.

Consequences, from the backtest reports:

- "Many exits are episode-boundary force-flattens after ~27h, truncating the
  'days'-horizon theses" — positions die by the clock, not by a signal.
- The judge sees stated price levels but they are unstructured prose, so only
  the LLM can act on them, and only once per 15-minute tick.
- Shorts run the long logic sign-flipped, with no asymmetric handling.
- No trailing stops, take-profit targets, volatility-scaled stops, or
  entry-relative time-stops.

## 2. Goal & non-goals

**Goal:** replace the single-stop-plus-LLM exit with a deterministic,
thesis-grounded exit engine that commits numeric exit levels at entry time and
enforces them every tick, in priority order, direction-aware, with the LLM
judge demoted to a qualitative overlay. Strictly additive: an entry with no
structured levels behaves exactly as today.

**Non-goals (YAGNI — each a documented follow-up):**
- Scaling out / partial exits (all-or-nothing here).
- Native OCO/bracket resting orders (tick engine + the existing native
  hard-stop leg only).
- ATR / volatility-scaled stops.
- Squeeze-aware short exits (borrow-rate / short-interest driven) — a defined
  hook the short-side spec plugs into, not built here.

## 3. Locked design decisions

1. **Exit discipline is built first**, as its own spec, ahead of the short side
   (its P&L effect is backtest-admissible and it needs no alpha
   pre-registration; a short book needs squeeze-aware exits anyway).
2. **Thesis-grounded, structured levels** are the source of truth (not a generic
   config-only overlay).
3. **All-or-nothing** exits: one exit per position, first trigger wins.
4. **Tick-based enforcement** of the structured triggers, plus the existing
   **native RTH hard-stop leg** for between-ticks worst-case protection.

## 4. Data model

### 4.1 `ThesisEntry.exit` (`src/types.ts`)

Add one optional field to `ThesisEntry` (leave everything else unchanged):

```ts
export interface ExitPlan {
  hardStopPct: number;          // worst-case loss %, > 0; drives the native RTH
                                //   stop leg AND the tick hard-stop check
  invalidationPrice?: number;   // numeric thesis-death level
                                //   (long: exit if price <= level; short: >=)
  target?: number;              // take-profit price (long: >=, short: <=)
  trail?: {
    activatePct: number;        // arm trailing once unrealized gain >= this %
    trailPct: number;           // then exit if price retraces trailPct from peak
  };
  timeStopHours?: number;       // exit if unresolved this many hours after entry
}
// ThesisEntry gains:  exit?: ExitPlan;
```

Prose `invalidationConditions: string[]` stays — the judge overlay still reads
it. `exit` is optional so historical theses and any entry the synthesizer
leaves bare still parse and run under the fallbacks (§6).

### 4.2 Config (`src/config.ts`, new `exit_engine` block)

```ts
exit_engine: {
  hardStopPct: number;        // default = max_position_loss_pct (8) — no regression
  short_hardStopPct?: number; // optional tighter stop for shorts; falls back to hardStopPct
  horizon_hours: {            // fallback timeStopHours by verdict horizon
    days: number;             // default 30 (conservative; revisit on soak data)
    weeks: number;            // default 120
  };
}
```

`max_position_loss_pct` is retained and remains the hard floor; `exit_engine`
values default from it so behavior is identical until the synthesizer starts
emitting `exit` blocks. (Exact default hour values are a tuning question, not a
correctness one — set conservatively, revisit on the soak.)

## 5. The exit engine

New pure module `src/exits.ts`, unit-tested in isolation, imported by
`src/executor-loop.ts` and by the backtest episode runner so live and sim share
one implementation.

### 5.1 Interface

```ts
export interface ExitContext {
  direction: 'long' | 'short';
  entryPrice: number;         // broker avg_entry_price
  entryTimeMs: number;        // fill time, from the audit entry / order
  markPrice: number;          // exit-side quote: long → bid, short → ask
  peakFavorablePrice: number; // high-water mark since entry (§5.4)
  nowMs: number;
  plan: ExitPlan;             // resolved (post-fallback) exit plan
}
export interface ExitDecision { exit: boolean; reason?: string; trigger?: ExitTrigger; }
export type ExitTrigger =
  | 'hard_stop' | 'invalidation_price' | 'target' | 'trail' | 'time_stop';
export function evaluateExit(ctx: ExitContext): ExitDecision;
```

`evaluateExit` is deterministic and side-effect-free. The judge overlay is NOT
inside it (the judge is an LLM call the executor makes separately, §7).

### 5.2 Priority (first trigger that fires wins)

1. `hard_stop` — risk first. `unrealizedLossPct >= plan.hardStopPct`.
2. `invalidation_price` — thesis dead. long: `mark <= invalidationPrice`;
   short: `mark >= invalidationPrice`.
3. `target` — pre-committed take-profit. long: `mark >= target`;
   short: `mark <= target`.
4. `trail` — armed once unrealized gain has reached `activatePct`; then exit
   when `mark` retraces `trailPct` from `peakFavorablePrice`
   (long: peak is the high; short: the low). If both `target` and `trail` are
   present, `target` wins (it is earlier in priority) — they are normally not
   both set; §12 notes let-it-run-past-target as a trailing-only follow-up.
5. `time_stop` — `nowMs - entryTimeMs >= timeStopHours * 3.6e6`. Replaces the
   blind episode-boundary force-flatten with an entry-relative horizon.

All comparisons are direction-aware. `unrealizedLossPct` is computed from
`entryPrice` and the exit-side `markPrice`, matching the existing conservative
marking (long → bid, short → ask) in `executor-loop.ts`.

### 5.3 Direction correctness

Shorts invert every level: stop is a price *above* entry, target *below*,
invalidation *above*, trailing tracks the *low*. This is the single most
test-heavy part of the module (§11) — a sign error here silently disables
protection.

### 5.4 Trailing high-water mark — persisted state

Ticks are independent processes; the system is file-driven and holds no memory
between ticks. Trailing therefore needs a persisted per-position high-water
mark, updated each tick. Add it to the existing state layer (`src/state.ts`):

- Key: `ticker` + `entryTimeMs` (so a re-opened name starts fresh).
- Value: `peakFavorablePrice`, updated to `max(prev, mark)` for longs /
  `min` for shorts each tick.
- Cleared when the position closes (executor already knows the close).

**Fidelity rule (load-bearing for admissibility):** the high-water mark updates
at **tick granularity only**, in both live and backtest — even though the
backtest has minute bars that could compute a truer intra-tick peak. Matching
the live approximation keeps the paired counterfactual (§9) honest about what
production will actually do. The minute-bar "true trail" is explicitly rejected
to avoid a live/sim gap.

## 6. Where the levels come from

The synthesis/narrative step emits the `exit` block; the executor only enforces
it.

- `computeThesisEntries` (`src/synthesis.ts`) → `writeNarratives`
  (`src/agents/narrative.ts`): the narrative/synthesis LLM output schema gains
  the structured `exit` fields, grounded in the same daily bars and the
  analysts' stated `invalidationConditions`. The model translates its own prose
  ("holds ~190") into `invalidationPrice: 190`, sets a `target` and/or `trail`,
  and a `timeStopHours` consistent with the verdict horizon.
- **Deterministic fallback** (in synthesis, not the executor) fills any field
  the LLM omits:
  - `hardStopPct` → `exit_engine.short_hardStopPct` for shorts else
    `exit_engine.hardStopPct`.
  - `timeStopHours` → `exit_engine.horizon_hours[verdict.horizon]`.
  - `invalidationPrice`, `target`, `trail` → left unset (those triggers simply
    don't fire).

So a bare entry degrades to "static hard stop + time-stop + judge overlay",
which is a strict superset of today's "static hard stop + judge" (today has no
time-stop, only the boundary flatten). No entry can regress below current
protection.

## 7. Executor integration (`src/executor-loop.ts`)

- Replace the inline `stopHit`/judge block (~305–343) with: resolve the
  position's `ExitPlan` (from the thesis entry, post-fallback), read/update the
  high-water mark, call `evaluateExit`. If it returns `exit`, take that reason.
- The **judge stays**, but as an overlay: call it only when `evaluateExit`
  returns no exit, to catch qualitative invalidations the numeric levels miss
  (`judge.exitPosition`). Orphan positions with no thesis entry keep
  stop-only monitoring (hard stop via fallback) exactly as today.
- **Native RTH stop leg** (~447): today it uses `max_position_loss_pct`. Change
  it to use the entry's resolved `hardStopPct` so the resting broker stop and
  the tick check agree. Extended-hours entries still can't rest a stop
  (unchanged); the tick hard-stop check covers them.
- **Audit**: the `exit` audit event gains `trigger` (the `ExitTrigger` or
  `'judge'`) and the numeric level that fired, so the report can attribute
  exits by reason.

## 8. Shorts (within exit scope)

- The engine is fully sign-correct (§5.3) and honors `short_hardStopPct` for a
  tighter short stop.
- Full squeeze-aware exit logic (tighten/flatten on borrow-rate or
  short-interest spikes) is **out of scope** but gets a named seam: the
  short-side spec will supply a `squeezePressure` input that can shorten the
  trail or force a time-stop. This spec only guarantees the engine is
  direction-correct and asymmetric-stop-capable so that hook is cheap to add.

## 9. Measurement & trial registry

- **Registered as a `guardrail` row**, not `alpha`: the exit engine adds no new
  entry signal and changes no entry selection. (Per the mechanism gate,
  guardrail rows need no mechanism statement.)
- **Effect measured by paired counterfactual** on the **same entries and the
  same realized fills** (current dumb exit vs structured engine) — the Stage-1
  machinery in `docs/QUANT-TESTING-PLAN.md`. Because exits act on realized
  price paths, not the optimistic fill model, this is backtest-**admissible**
  the same way the Stage-3 variance-sizing guardrails are.
- **Primary metrics:** realized net P&L per trade, book vol, max drawdown, and
  the **force-flatten-truncation rate** (share of exits that were blind
  boundary flattens before vs after).
- **Honest caveat (in the registry notes):** take-profit and trailing rules
  change the return distribution, so any *mean-P&L* improvement is reported
  under the "backtest disproves only" banner and earns the same paper-soak
  scrutiny as alpha. The guardrail claim is **risk-shape** (lower drawdown/vol,
  fewer blind truncations), not edge.

Draft registry row (`trial-registry.yaml`):

```yaml
- id: exit-engine-v1
  date: "2026-07-11"
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

## 10. Backtest integration

- The episode runner (`scripts/backtest-episode.ts`) calls the same
  `src/exits.ts` and the same tick-granularity high-water mark (§5.4).
- Add one **paired sweep cell**: structured engine ON vs OFF over the identical
  episode set (the plan's paired-difference requirement — never unpaired
  totals). Report the §9 metrics with `bootstrapCi`, design-weighted, never
  H-stratum alone.
- The episode-boundary force-flatten stays as a backstop, but the report must
  distinguish a structured `time_stop` exit from a boundary flatten so the
  truncation-rate metric is meaningful.

## 11. Testing

- **Unit (`tests/exits.test.ts`)**: each trigger in isolation; the priority
  order when several are simultaneously true; long vs short direction
  correctness for every trigger; trailing arm/retrace math and high-water
  update; graceful degradation (bare plan → hard-stop + time-stop only).
- **Schema**: `ThesisEntry.exit` parses when present and when absent; config
  `exit_engine` defaults reproduce current behavior.
- **State**: high-water persistence round-trips and clears on close.
- **Integration (`tests/executor-helpers.test.ts` or a new file)**: executor
  takes the engine's exit; judge is consulted only when the engine abstains;
  native stop leg uses the entry's `hardStopPct`.
- **Backtest**: the paired cell runs on identical episodes; audit `trigger`
  attribution is populated.

## 12. Out of scope / follow-ups (documented)

- Scaling out / partial exits (needs position-fraction tracking + multiple
  resting orders + attribution changes).
- Let-winners-run: trailing that overrides a fixed target.
- Native OCO/bracket resting orders (both legs fire between ticks in RTH).
- ATR / volatility-scaled stops (reuse `stddev` in `src/signals.ts`).
- Squeeze-aware short exits (short-side spec supplies `squeezePressure`).

## 13. File-by-file change list

- `src/types.ts` — add `ExitPlan`, `ThesisEntry.exit?`.
- `src/config.ts` — add `exit_engine` block with backward-compatible defaults.
- `src/exits.ts` — **new** pure engine (`evaluateExit`, `ExitContext`, etc.).
- `src/state.ts` — per-position high-water mark persistence + clear-on-close.
- `src/synthesis.ts` / `src/agents/narrative.ts` — emit + fallback-fill `exit`.
- `src/executor-loop.ts` — swap the stop/judge block for the engine; judge as
  overlay; native stop leg uses entry `hardStopPct`; richer `exit` audit.
- `scripts/backtest-episode.ts` — engine + tick-granularity high-water; distinct
  time-stop vs boundary-flatten.
- `scripts/backtest.ts` — paired exit-engine sweep cell + report metrics.
- `trial-registry.yaml` / `docs/TRIAL-REGISTRY.md` — the guardrail row.
- Tests as in §11.

## 14. Risks & open questions

- **LLM level quality**: the synthesizer must produce sane numeric levels from
  prose. Mitigation: deterministic fallbacks make bad/absent levels safe, and
  the paired backtest cell will show whether LLM-set targets help or hurt vs
  fallback-only.
- **Entry-time source**: the engine needs a reliable `entryTimeMs`; confirm the
  audit entry (or order fill) gives it in both live and sim. Fallback: first
  tick that observes the position.
- **Default horizon hours**: `days`/`weeks` → hours is a tuning choice; set
  conservative, revisit on soak data, not a correctness gate.
- **Time-stop vs thesis expiry interaction**: time-stop is entry-relative;
  thesis expiry is absolute. Both may exit a position; the report attributes to
  whichever fires first.
