# Off-Hours Trader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Multi-agent stock system that discovers its own candidates, synthesizes a thesis from five analyst viewpoints, and trades it during US extended hours against an Alpaca paper account (live-connectable later), with a React dashboard.

**Architecture:** Evening pipeline (discover → verdicts → synthesize → `out/thesis-*.json`) is decoupled from an executor loop (thesis + live quotes → LLM judge → deterministic risk gate → broker). An Express server exposes state files + config to a Vite/React dashboard. All money-relevant math is plain code; LLMs produce structured nominations/verdicts/narratives/judgments only.

**Tech Stack:** TypeScript (ESM, Node 22, pnpm), `@anthropic-ai/sdk`, Alpaca REST (trading + market data + news), zod, yaml, Express, React 19 + Vite, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-07-offhours-trader-design.md` — non-negotiables: paper by default; live needs `mode: live` + live keys + `live_trading_acknowledged: true` or refuse to start; risk gate deterministic; default posture "do nothing".

---

## File structure

```
package.json  tsconfig.json  vitest.config.ts  config.yaml  .env.example  README.md
src/
  types.ts            # shared contract (below, verbatim)
  config.ts           # zod schema, load/save config.yaml, live-mode triple check
  clock.ts            # ET time + session windows (DST-safe via Intl)
  paths.ts            # out/ file path helpers (dated names)
  audit.ts            # JSONL append + read-tail
  state.ts            # halt/resume state file
  risk.ts             # deterministic risk gate
  candidates.ts       # deterministic nomination merge/filter/cap
  synthesis.ts        # deterministic conviction math + sizing + bands
  broker/client.ts    # BrokerClient iface + AlpacaBroker (paper/live/dry-run)
  broker/marketdata.ts# movers, most-actives, news, bars, latest quotes
  agents/llm.ts       # anthropic client, callStructured() forced tool-use helper
  agents/prompts.ts   # 5 analyst personas + synthesizer + executor-judge prompts
  agents/nominate.ts  # Round 1
  agents/verdicts.ts  # Round 2
  agents/narrative.ts # thesis narratives
  agents/judge.ts     # executor-tick judgment
  pipeline.ts         # entry: evening pipeline
  executor-loop.ts    # entry: one executor tick (scheduler calls repeatedly)
  server.ts           # Express API + static frontend
scripts/seed-demo.ts  # writes fake out/ files so the dashboard renders keyless
tests/                # vitest: risk, config, clock, candidates, synthesis, broker, integration replay
fixtures/             # recorded scans/quotes/agent outputs for replay test
frontend/             # Vite React app (src/App.tsx, api.ts, panels/*, styles.css)
```

## Shared contract — `src/types.ts` (verbatim)

```ts
export type Mode = 'dry-run' | 'paper' | 'live';
export type Direction = 'long' | 'short' | 'none';
export type AnalystName = 'fundamental' | 'technical' | 'macro' | 'sentiment' | 'bear';
export const ANALYSTS: AnalystName[] = ['fundamental', 'technical', 'macro', 'sentiment', 'bear'];
export type Session = 'premarket' | 'rth' | 'afterhours' | 'closed';

export interface Nomination { ticker: string; reason: string; }
export interface AnalystNominations { analyst: AnalystName; nominations: Nomination[]; }

export interface Candidate {
  ticker: string;
  nominatedBy: { analyst: AnalystName; reason: string }[];
  lastPrice: number;
  avgDollarVolume20d: number;
}
export interface CandidateFile {
  date: string; // YYYY-MM-DD (ET)
  candidates: Candidate[];
  rejected: { ticker: string; reason: string }[];
}

export interface Verdict {
  analyst: AnalystName;
  ticker: string;
  direction: Direction;
  conviction: number; // 0..1
  horizon: 'days' | 'weeks';
  evidence: string[];
  invalidation_conditions: string[];
}
export interface VerdictFile { date: string; verdicts: Verdict[]; droppedAnalysts: AnalystName[]; }

export interface ThesisEntry {
  ticker: string;
  direction: 'long' | 'short';
  weightedConviction: number;
  limitBand: { low: number; high: number };
  targetNotionalUsd: number;
  narrative: string;
  invalidationConditions: string[];
}
export interface Thesis {
  date: string;
  generatedAt: string; // ISO
  expiresAt: string;   // ISO
  entries: ThesisEntry[];
  skipped: { ticker: string; reason: string }[];
}

export interface QuoteSnapshot {
  ticker: string; bid: number; ask: number; bidSize: number; askSize: number;
  last: number; asOf: string;
}

export interface ProposedOrder {
  ticker: string; side: 'buy' | 'sell'; qty: number; limitPrice: number;
  intent: 'entry' | 'exit'; reason: string;
}
export interface RiskDecision { allowed: boolean; reasons: string[]; }

export interface Position {
  ticker: string; qty: number; avgEntryPrice: number; marketValue: number;
  unrealizedPl: number; side: 'long' | 'short';
}
export interface AccountSnapshot { equity: number; cash: number; positions: Position[]; }
export interface BrokerOrder {
  id: string; ticker: string; side: 'buy' | 'sell'; qty: number;
  limitPrice: number; status: string; submittedAt: string;
}

export interface HaltState { halted: boolean; reason: string; at: string; }
export interface AuditEvent {
  ts: string; kind: 'nomination' | 'candidates' | 'verdict' | 'thesis' | 'tick' |
    'proposed_order' | 'order_placed' | 'order_rejected' | 'exit' | 'halt' | 'resume' | 'error';
  data: unknown;
}
```

## Config schema — `src/config.ts` (core, verbatim)

```ts
import { z } from 'zod';
export const ConfigSchema = z.object({
  mode: z.enum(['dry-run', 'paper', 'live']).default('paper'),
  live_trading_acknowledged: z.boolean().default(false),
  universe: z.object({
    nominations_per_agent: z.number().int().min(1).max(10).default(5),
    max_candidates: z.number().int().min(1).max(50).default(15),
    min_price: z.number().positive().default(5),
    min_avg_dollar_volume: z.number().positive().default(20_000_000),
    exclude: z.array(z.string()).default([]),
  }).default({}),
  sessions: z.object({
    premarket: z.boolean().default(true),
    afterhours: z.boolean().default(true),
  }).default({}),
  agent_weights: z.object({
    fundamental: z.number().min(0).default(1.0),
    technical: z.number().min(0).default(0.8),
    macro: z.number().min(0).default(0.6),
    sentiment: z.number().min(0).default(1.0),
    bear: z.number().min(0).default(1.2),
  }).default({}),
  conviction_threshold: z.number().min(0).max(1).default(0.65),
  quorum: z.number().int().min(1).max(5).default(3),
  max_position_pct: z.number().positive().default(5),
  max_daily_deploy_pct: z.number().positive().default(10),
  max_order_notional_usd: z.number().positive().default(2000),
  max_spread_bps: z.number().positive().default(50),
  max_chase_pct: z.number().positive().default(1),   // limit band above reference close
  max_drop_pct: z.number().positive().default(3),    // limit band below reference close
  daily_loss_halt_pct: z.number().positive().default(3),
  executor_interval_min: z.number().int().positive().default(15),
  thesis_run_time_et: z.string().default('17:00'),
  model: z.object({
    analysts: z.string().default('claude-sonnet-5'),
    synthesizer: z.string().default('claude-fable-5'),
    executor: z.string().default('claude-sonnet-5'),
  }).default({}),
});
export type Config = z.infer<typeof ConfigSchema>;
```

Also in `config.ts`:
- `loadConfig(path = 'config.yaml'): Config` — parse YAML, `ConfigSchema.parse`; throw with readable message on invalid.
- `saveConfig(next: unknown, path): Config` — validate; **force `mode` and `live_trading_acknowledged` to current on-disk values** (API cannot change them); write YAML; return parsed.
- `assertModeRunnable(cfg: Config, env: NodeJS.ProcessEnv): void` — mode `live` requires `live_trading_acknowledged === true` AND `ALPACA_LIVE_KEY` AND `ALPACA_LIVE_SECRET`, else `throw new Error('refusing to start in live mode: ...')`. Never downgrade silently. Modes paper/dry-run require `ALPACA_PAPER_KEY`/`SECRET` only when broker reads are needed (executor/server), not for config validation.

## Deterministic algorithms (verbatim behavior)

### `src/clock.ts`
```ts
export function nowET(d = new Date()): { ymd: string; hm: string; minutes: number; dow: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
  }).formatToParts(d);
  // assemble ymd 'YYYY-MM-DD', hm 'HH:mm', minutes since midnight, dow 0-6 (Sun=0)
}
export function currentSession(d = new Date()): Session {
  const { minutes, dow } = nowET(d);
  if (dow === 0 || dow === 6) return 'closed';
  if (minutes >= 240 && minutes < 570) return 'premarket';   // 04:00–09:30
  if (minutes >= 570 && minutes < 960) return 'rth';         // 09:30–16:00
  if (minutes >= 960 && minutes < 1200) return 'afterhours'; // 16:00–20:00
  return 'closed';
}
export function sessionEnabled(s: Session, cfg: Config): boolean {
  return (s === 'premarket' && cfg.sessions.premarket) || (s === 'afterhours' && cfg.sessions.afterhours);
}
```
Known v1 limitation (document in README): market holidays are treated as weekdays; broker rejects orders those days.

### `src/candidates.ts`
`buildCandidates(nominations: AnalystNominations[], marketInfo: Map<ticker,{lastPrice, avgDollarVolume20d}>, cfg): CandidateFile`
1. Uppercase tickers; union nominations; collect `nominatedBy` per ticker.
2. Reject with reason: on `cfg.universe.exclude` (case-insensitive); `lastPrice < min_price`; `avgDollarVolume20d < min_avg_dollar_volume`; missing market info (`'no market data'`).
3. Rank by (nominatedBy.length desc, avgDollarVolume20d desc); keep top `max_candidates`; overflow rejected with reason `'over max_candidates cap'`.

### `src/synthesis.ts`
`computeThesisEntries(verdicts: Verdict[], marketInfo, account: AccountSnapshot, cfg): { entries: Omit<ThesisEntry,'narrative'>[]; skipped: {ticker; reason}[] }`
Per ticker with ≥1 verdict:
1. `respondingWeightSum` = Σ cfg.agent_weights[analyst] over analysts with a verdict on this ticker.
2. Quorum: verdict count (any direction incl. `none`) < cfg.quorum → skip `'quorum'`.
3. `longScore` = Σ (weight×conviction over direction==='long') / respondingWeightSum; `shortScore` likewise.
4. Disagreement: `Math.min(longScore, shortScore) >= 0.3` → skip `'disagreement'`.
5. direction = higher score; `weightedConviction` = that score; below `conviction_threshold` → skip `'below threshold'`.
6. `P` = lastPrice. Long band: `{ low: P*(1-max_drop_pct/100), high: P*(1+max_chase_pct/100) }`. Short band mirrored: `{ low: P*(1-max_chase_pct/100), high: P*(1+max_drop_pct/100) }`.
7. `targetNotionalUsd = Math.min(cfg.max_order_notional_usd, account.equity * cfg.max_position_pct/100) * weightedConviction`, rounded to cents.
8. Union of invalidation_conditions from verdicts agreeing with `direction`.

`thesisExpiry(dateYmd)`: 20:00 ET of the **next** weekday after `dateYmd`, as ISO UTC.

### `src/risk.ts`
```ts
export interface RiskContext {
  config: Config; account: AccountSnapshot; openOrders: BrokerOrder[];
  deployedTodayUsd: number; dailyPl: number; halted: boolean;
}
export function riskCheck(order: ProposedOrder, ctx: RiskContext): RiskDecision
```
Collect ALL failing reasons (don't short-circuit). Rules:
1. `halted` → `'trading halted'`.
2. Kill switch: `ctx.dailyPl <= -(ctx.account.equity * cfg.daily_loss_halt_pct / 100)` → `'daily loss halt'`. (Caller writes HaltState when tripped.)
3. `!Number.isFinite(order.limitPrice) || order.limitPrice <= 0` → `'invalid limit price'`.
4. `!Number.isInteger(order.qty) || order.qty < 1` → `'invalid qty'`.
5. Ticker on `cfg.universe.exclude` → `'excluded ticker'`.
6. notional = qty×limitPrice. Entry only: notional > `max_order_notional_usd` → `'exceeds max order notional'`.
7. Entry only: existing position `|marketValue|` + notional > equity×max_position_pct/100 → `'exceeds max position size'`.
8. Entry only: deployedTodayUsd + notional > equity×max_daily_deploy_pct/100 → `'exceeds max daily deployment'`.
9. Open order exists for same ticker+side → `'duplicate open order'`.
Exit orders (`intent:'exit'`) skip rules 6–8 — closing risk is always allowed (but never rule 1/2? — halt blocks entries only; exits ALLOWED when halted: closing reduces risk. Rule 1 and 2 apply to entries only).
`allowed = reasons.length === 0`.

## Broker & market data

### `src/broker/client.ts`
`interface BrokerClient { getAccount(): Promise<AccountSnapshot>; getOpenOrders(): Promise<BrokerOrder[]>; getTodayOrders(): Promise<BrokerOrder[]>; placeLimitOrder(o: ProposedOrder): Promise<BrokerOrder>; }`

`class AlpacaBroker implements BrokerClient`:
- `constructor(cfg: Config, env)` → `assertModeRunnable`; base URL `https://paper-api.alpaca.markets` (paper & dry-run) / `https://api.alpaca.markets` (live); headers `APCA-API-KEY-ID`/`APCA-API-SECRET-KEY` from the mode-matching env slots (`ALPACA_PAPER_*` for paper+dry-run, `ALPACA_LIVE_*` for live; no fallback between slots).
- `placeLimitOrder`: body `{symbol, qty: String(qty), side, type: 'limit', time_in_force: 'day', limit_price: String(limitPrice), extended_hours: true}`. **In `dry-run` mode: do NOT call the API**; return synthetic `BrokerOrder{ id: 'dry-'+timestamp, status: 'dry_run' }`.
- All fetches: 2 retries, backoff 1s/3s, then throw. Map Alpaca JSON → our types.
- `dailyPlFrom(account, todayOrders)` helper not needed — compute dailyPl as Σ position.unrealizedPl + (equity − last_equity from Alpaca account raw field `last_equity`). Expose `getDailyPl(): Promise<number>` using account `equity - last_equity`.

### `src/broker/marketdata.ts` (base `https://data.alpaca.markets`, same paper creds; IEX feed)
- `getMovers(top=20)` → `/v1beta1/screener/stocks/movers?top=` → `{gainers, losers}` arrays `{symbol, percent_change, price}`.
- `getMostActives(top=30)` → `/v1beta1/screener/stocks/most-actives?by=volume&top=`.
- `getNews(limit=50, symbols?)` → `/v1beta1/news` → `{headline, summary, symbols, created_at, source}[]`.
- `getDailyBars(symbols, limit=25)` → `/v2/stocks/bars?timeframe=1Day&feed=iex` (chunk symbols ≤ 100/call) → per-symbol bars `{o,h,l,c,v,t}`.
- `getLatestQuotes(symbols)` → `/v2/stocks/quotes/latest?feed=iex` + `/v2/stocks/trades/latest` → `QuoteSnapshot[]` (spread from bid/ask, `last` from latest trade).
- `marketInfoFor(symbols)` → bars → `{lastPrice: last close, avgDollarVolume20d: mean(c×v over ≤20 bars)}`.

## LLM agents

### `src/agents/llm.ts`
`callStructured<T>(opts: {model, system, user, toolName, toolSchema, maxTokens?})` — anthropic `messages.create` with one tool + `tool_choice: {type:'tool', name}`; extract `tool_use` input; throw on refusal/missing. 2 retries on 429/5xx/overloaded.

### `src/agents/prompts.ts`
Five persona system prompts. Common frame: "You are the {X} analyst on a 5-analyst panel at a systematic trading desk. Extended-hours trading only: US pre-market and after-hours. Be selective; abstain freely — `none`/empty output is a valid answer. Never invent data; reason only from the data provided." Purviews per spec table. Bear persona: "Your mandate is adversarial: find the reasons NOT to do each trade — crowded positioning, liquidity traps, binary event risk, stale narratives. You may issue a contrary-direction verdict when you have conviction."
Synthesizer narrative prompt: given per-ticker computed direction/conviction/verdict evidence, write 3–5 sentence cohesive thesis reconciling the viewpoints, plus merged deduplicated invalidation list.
Executor-judge prompt: "You do not research. Given a thesis entry, a live quote, and headlines since the thesis was generated, decide whether entry conditions still hold and whether any invalidation condition has triggered."

### Round functions
- `nominate.ts`: `runNominations(cfg, scans) → AnalystNominations[]` — `Promise.allSettled` over 5 analysts, model `cfg.model.analysts`, tool `submit_nominations` `{nominations: [{ticker, reason}] (max nominations_per_agent)}`; purview-matched payloads (fundamental: news + most-actives; technical: movers + bars for movers; macro: movers by sector + news; sentiment: news; bear: everything, asked what to AVOID — bear nominations are tickers it wants the panel to examine skeptically and count as nominations like any other). Failed analyst → dropped, audited.
- `verdicts.ts`: `runVerdicts(cfg, candidates, data) → VerdictFile` — 5 × allSettled, tool `submit_verdicts` `{verdicts: Verdict[]}` (analyst field injected by code, not the model); data: per-candidate bars summary, latest news for its symbols, nomination reasons.
- `narrative.ts`: `writeNarratives(cfg, computedEntries, verdicts) → Map<ticker, {narrative, invalidationConditions}>` — model `cfg.model.synthesizer`, one call, tool `submit_narratives`. On failure: fallback narrative = concatenated top evidence lines (pipeline must not die on narrative polish).
- `judge.ts`: `judgeTick(cfg, entry, quote, headlines, position?) → {proceed: boolean; exitPosition: boolean; reasons: string[]}` — model `cfg.model.executor`, tool `submit_execution_decision`. **LLM can only veto/confirm; code has already enforced quantitative gates. On judge failure/timeout: proceed=false (do nothing).**

## Entry points

### `src/pipeline.ts` (`pnpm pipeline`)
1. load config (+ dotenv), audit `tick {stage:'pipeline_start'}`.
2. Scans: movers, most-actives, news (parallel).
3. Round 1 nominations → audit each.
4. `marketInfoFor(union tickers)` → `buildCandidates` → write `out/candidates-YMD.json`, audit.
5. Zero candidates → write empty thesis (entries: []), exit 0.
6. Round 2: bars+news for candidates → `runVerdicts` → write `out/verdicts-YMD.json`, audit each verdict.
7. Broker `getAccount()` (paper creds; needed for sizing) → `computeThesisEntries`.
8. `writeNarratives` → assemble `Thesis` (expiry via `thesisExpiry`) → write `out/thesis-YMD.json`, audit.
Any thrown error: audit `error`, exit 1 (no partial thesis file — write via temp+rename).

### `src/executor-loop.ts` (`pnpm tick`)
1. load config; session = currentSession(); if `!sessionEnabled(session, cfg)` → audit tick `'session closed/disabled'`, exit 0.
2. `readHaltState()`; broker snapshot: account, open orders, dailyPl. If kill-switch condition and not halted → `writeHalt('daily loss halt')`, audit.
3. Load newest unexpired thesis (today else yesterday, check `expiresAt`); none → exit 0.
4. Exits first: for each open position matching a thesis entry (or orphaned position with a past thesis), fetch quote + headlines since thesis.generatedAt → `judgeTick` with position → if `exitPosition`: ProposedOrder `{side: long?'sell':'buy', qty: |position.qty|, limitPrice: long? bid : ask, intent:'exit'}` → riskCheck → place → audit.
5. Entries: for each thesis entry without an existing position or open order: quote checks in code — spread bps = `(ask-bid)/((ask+bid)/2)*10000 > cfg.max_spread_bps` → skip audit reason; `bidSize<1||askSize<1` skip; `last` outside `limitBand` skip. Then `judgeTick` → if proceed: `limitPrice = direction==='long' ? Math.min(ask, band.high) : Math.max(bid, band.low)`; `qty = Math.floor(targetNotionalUsd / limitPrice)`; qty<1 skip → riskCheck → allowed? `placeLimitOrder` (dry-run returns synthetic) → audit `order_placed` / `order_rejected`.
6. Always audit a `tick` summary event.
`deployedTodayUsd` = Σ qty×limitPrice over today's non-canceled buy-side entry orders from `getTodayOrders()`.

### `src/server.ts` (`pnpm serve`, port 4310)
Express; `express.json()`; serve `frontend/dist` static if exists. Endpoints per spec §6: status (mode, session, halt, equity or null if creds missing — status must not 500 keyless), candidates/thesis/verdicts (latest file or `{}`), positions/orders (broker; `[]` + `{error}` field keyless), audit tail (default 100, newest first), config GET (parsed) / PUT (via `saveConfig` — mode/ack immutable), actions POST: pipeline/run + executor/tick spawn `pnpm tsx src/{pipeline|executor-loop}.ts` detached (one at a time; 409 if still running), halt/resume write state. Errors: JSON `{error}` with 4xx/5xx, never crash.

## Frontend (`frontend/`)
Vite + React 19 + TS. `vite.config.ts` proxy `/api` → `http://localhost:4310`. Poll all GETs every 10s (`useEffect` + `setInterval`, `api.ts` typed fetchers mirroring `src/types.ts`). Light theme, white background, system font stack, minimal hand-rolled CSS (`styles.css`) — no UI framework. Layout: sticky status bar; two-column main grid; panels per spec §6: StatusBar, CandidatesPanel (table: ticker, nominators as small tags with reason tooltips, filtered-out list collapsed), ThesisPanel (card per entry: direction pill LONG/SHORT, conviction bar, band, notional, narrative, invalidation list, expiry countdown; skipped list with reasons), VerdictsPanel (matrix: rows tickers × cols analysts, cell = direction glyph + conviction, click to expand evidence), PositionsOrders (two tables; rejected orders show risk reasons), AuditFeed (monospace, newest first, kind-colored dot), ConfigEditor (numeric inputs + weight sliders + session toggles + exclude tag input; mode & ack rendered as read-only badges with note "edit config.yaml by hand"; Save → PUT, show validation errors), ActionsBar (Run pipeline / Tick now / Halt / Resume with confirm on Halt). Mode badge colors: dry-run gray, paper blue, live red.

## Testing (Vitest)
- `tests/risk.test.ts` — every rule + boundaries: exactly-at-cap notional allowed; 1¢ over rejected; exits allowed while halted; entries rejected while halted; kill-switch boundary equality trips; duplicate detection same ticker+side only; multiple reasons accumulate.
- `tests/config.test.ts` — defaults fill; invalid rejects; `saveConfig` cannot flip mode/ack; `assertModeRunnable` live-refusal paths (ack false / keys missing / both) + paper OK.
- `tests/clock.test.ts` — fixed Date fixtures (UTC) for: premarket/rth/afterhours/closed edges 04:00, 09:29, 09:30, 15:59, 16:00, 19:59, 20:00 ET; weekend; DST check (a January date and a July date both map 17:00 ET correctly).
- `tests/candidates.test.ts` — exclude, min price, min dollar volume, cap ordering by nomination count then volume, missing market data.
- `tests/synthesis.test.ts` — quorum, disagreement (both ≥0.3), threshold, weighted math against hand-computed values, band arithmetic, conviction-scaled sizing cap, `none` verdicts count toward quorum but not scores, expiry skips weekend.
- `tests/broker.test.ts` — mocked fetch: order body exactly `{type:'limit', time_in_force:'day', extended_hours:true}`; dry-run never fetches on place; live-mode constructor refusal; retry-then-throw.
- `tests/replay.test.ts` — integration: fixtures for scans/bars/quotes + canned LLM outputs (mock `callStructured`), run pipeline logic end-to-end → assert candidates/verdicts/thesis files' shape and math; then run executor-tick logic against fixture quotes in dry-run → assert audited proposed orders pass risk gate.

## Tasks (dependency order)

- [ ] **Task 1 — Scaffold + contract:** package.json (`pipeline`, `tick`, `serve`, `test`, `build`, `seed` scripts; deps above), tsconfig (ES2022, NodeNext, strict), vitest.config.ts, `.env.example` (ANTHROPIC_API_KEY, ALPACA_PAPER_KEY/SECRET, commented ALPACA_LIVE_*), default `config.yaml` (spec §5 values, mode: paper), `src/types.ts` verbatim, `src/paths.ts`. Commit.
- [ ] **Task 2 — config/clock/audit/state** + their tests green. Commit.
- [ ] **Task 3 — risk gate** + tests green. Commit.
- [ ] **Task 4 — candidates + synthesis** + tests green. Commit.
- [ ] **Task 5 — broker client + market data** + tests green. Commit.
- [ ] **Task 6 — agents** (llm, prompts, nominate, verdicts, narrative, judge). Commit.
- [ ] **Task 7 — pipeline + executor-loop entry points.** Commit.
- [ ] **Task 8 — server + seed-demo script.** Commit.
- [ ] **Task 9 — frontend.** Build passes; panels render against seeded data. Commit.
- [ ] **Task 10 — replay integration test + README** (setup, key wiring, demo→live procedure, holiday limitation, launchd/cron examples). Full `pnpm test` + `tsc --noEmit` + frontend build green. Commit.

Every task: run `pnpm vitest run <its tests>` and `pnpm tsc --noEmit` before its commit.
