# Operator Terminal UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current Instrument dashboard with a flat, readable operator terminal that preserves every existing route and mutation while making account, automation, decision, risk, stale-data, and error state explicit.

**Architecture:** A thin AppShell owns hash routing, ten-second polling, mutations, and persistent operational state. Focused route components receive typed data and callbacks; pure presentation modules convert API records into clinical rows without recreating trading logic. Shared pane, table, linked-selection, resizable-workspace, action, and status primitives provide the terminal grammar across desktop and mobile.

**Tech Stack:** React 19, TypeScript 5.7 strict mode, Vite 6, Vitest 3.2, jsdom 26, React Testing Library 16, semantic HTML tables and ARIA modal controls, CSS Grid, CSS custom properties, localStorage.

## Global Constraints

- Keep the existing hash route IDs exactly: overview, thesis, positions, backtest, config, audit.
- Expose those routes as Monitor, Research, Positions, Backtest, Configuration, and Audit.
- Keep every existing API endpoint and the ten-second polling interval; make no backend trading, broker, or risk-rule change.
- Do not add global symbol search, manual order entry, new market-data endpoints, arbitrary widget docking, authentication, or live-mode activation changes.
- Use an edge-to-edge workspace, persistent operational header, linked panes, resizable desktop columns, dominant monitor tables, chronological activity, progressive disclosure, and plain clinical language.
- Do not use cards, decorative pills, status dots, glows, gradients, glass, ambient graphics, large radii, shadows, ornamental charts, decorative icon systems, promotional copy, gamification, or invented data.
- Use native system sans for UI and native monospace for numeric data; default text is 13–14 px, desktop table rows are 36 px, and no interface text is below 11 px.
- Start with canvas #0b0d0e, pane #111416, raised #181d20, separator #2a3034, text #eef1f2, secondary #8e979d, blue #5b9bd5, green #65ba8c, red #d96666, and amber #d2a653.
- Green means positive, long, completed, or healthy; red means negative, short, rejected, or dangerous; amber means pending, blocked, stale, or closed; blue means selection or linked context.
- Every semantic color must be paired with visible text, a sign, or another non-color cue.
- Use sentence case and these primary terms: Analysis, Execution check, Trading plan, Analyst view, No position, Confidence, Required analyst count, and Risk checks.
- Never imply that an order was placed when a mutation response is unknown.
- Keep all absent values absent: render Not recorded or Not available from current API instead of estimating confidence, deployment, market data, or outcomes.
- Below 900 px use a persistent Monitor/Research/Positions/More bottom navigation, a one-column reading flow, a control sheet, 44 px touch targets, mobile detail screens, no resize handles, and no horizontal body overflow.
- At 900–1015 px retain the six desktop route tabs but use a stacked Monitor workspace with no resize handles. This arithmetic-safe compact state is required because the minimum three-column width is 220 + 480 + 300 plus two separators.
- At 1016 px and wider render the three-column Monitor workspace. Constrain left to 220–360 px, right to 300–480 px, center to at least 480 px; persist widths and reset them by double-clicking a divider.
- Respect prefers-reduced-motion and use no entrance choreography or perpetual animation.
- Required final commands are pnpm --dir frontend build, pnpm typecheck, and pnpm test.
- Required browser viewports are 1440x900, 1024x768, 768x1024, and 390x844.

---

## File Structure

### Application and contracts

| Path | Responsibility |
| --- | --- |
| frontend/src/App.tsx | Thin default export of AppShell. |
| frontend/src/app/AppShell.tsx | Route composition, operational header, desktop/mobile navigation, controller wiring, and route-level mutation feedback. |
| frontend/src/app/operatorState.ts | OperatorSnapshot, polling/action state, empty state, and pure all-settled merge logic. |
| frontend/src/app/useOperatorController.ts | Immediate and ten-second polling, overlap guard, mutations, and last-known-good state. |
| frontend/src/router.ts | Preserved hash IDs plus visible route metadata. |
| frontend/src/types.ts | Frontend mirror of backend domain contracts, including raw unknown audit kinds. |
| frontend/src/api.ts | Endpoint normalization and discriminated mutation results. |

### Shared shell and workspace

| Path | Responsibility |
| --- | --- |
| frontend/src/components/shell/OperationalHeader.tsx | Product, route tabs, mode/session/broker/feed/refresh/halt/clock state, and desktop actions. |
| frontend/src/components/shell/WorkspaceTabs.tsx | Six desktop tabs and mobile primary/More route navigation. |
| frontend/src/components/shell/MobileControlSheet.tsx | Focus-trapped modal control sheet for operational state and actions below 900 px. |
| frontend/src/components/workspace/Pane.tsx | Structural region title, optional tabs and toolbar, and accessible labeling. |
| frontend/src/components/workspace/DataTable.tsx | Real table headers, numeric alignment, selectable/expandable rows, and contained overflow. |
| frontend/src/components/workspace/StatusMessage.tsx | Clinical loading, empty, stale, success, warning, and error output with live regions. |
| frontend/src/components/workspace/ActionControl.tsx | Pending, confirmation, success, and failure behavior for operator actions. |
| frontend/src/components/workspace/MasterDetail.tsx | Adjacent desktop detail and closable mobile detail screen. |
| frontend/src/components/workspace/ResizableWorkspace.tsx | Constrained widths, keyboard/pointer resizing, persistence, reset, and compact fallback. |
| frontend/src/hooks/useLinkedSelection.ts | Stable key-based selection through refreshes and mobile detail-open state. |
| frontend/src/ui.tsx | Compatibility barrel that exports only the new shared primitives. |

### Presentation and routes

| Path | Responsibility |
| --- | --- |
| frontend/src/presentation/format.ts | ET timestamps, duration/age, money, percentage, and plain status formatting. |
| frontend/src/presentation/candidates.ts | Candidate decision rows derived from recorded candidate, analyst-view, plan, and config data. |
| frontend/src/presentation/audit.ts | Known/unknown event classification, status, stage, clinical description, structured fields, and raw JSON. |
| frontend/src/presentation/positions.ts | Plain broker status, today's ET orders, and risk-rejection rows. |
| frontend/src/presentation/backtest.ts | API-backed threshold summaries and chart coordinates only. |
| frontend/src/views/MonitorView.tsx | Account/automation panes, dominant candidate monitor, linked detail, and activity blotter. |
| frontend/src/views/ResearchView.tsx | Candidate/filtered/plan tables, analyst matrix, and synchronized plan detail. |
| frontend/src/views/PositionsView.tsx | Positions, Orders, and Risk rejections tabs with row detail. |
| frontend/src/views/BacktestView.tsx | P&L chart, sweep table, and trade log without unsupported claims. |
| frontend/src/views/ConfigurationView.tsx | Grouped supported fields, read-only mode/ack state, dirty-server warning, and save feedback. |
| frontend/src/views/config/configDraft.ts | Pure protected-draft reducer and save-payload construction. |
| frontend/src/views/config/useConfigDraft.ts | Reducer/controller bridge for polled config and async saves. |
| frontend/src/views/AuditView.tsx | Activity/status filters, parsed table, structured expansion, and raw JSON. |

### Tests and global presentation

| Path | Responsibility |
| --- | --- |
| frontend/src/test/setup.ts | Testing Library cleanup, browser API shims, storage and viewport reset. |
| frontend/src/test/fixtures.ts | Complete fixed-date typed domain fixtures. |
| frontend/src/test/viewport.ts | Deterministic viewport and matchMedia helper. |
| frontend/src/**/*.test.ts(x) | Focused unit/component/integration tests beside production code. |
| frontend/src/styles.css | Complete flat operator-terminal visual system and responsive behavior. |
| frontend/index.html | Native-font document shell and product title. |
| DESIGN.md | Short pointer to the approved design spec and this implementation plan. |

Delete the superseded route files frontend/src/views/Overview.tsx, frontend/src/views/ThesisView.tsx, and frontend/src/views/ConfigView.tsx after their replacements compile. Keep frontend/src/main.tsx unchanged.

---

### Task 1: Frontend Test Harness and API Contract Fidelity

**Files:**
- Modify: frontend/package.json
- Modify: package.json
- Modify: pnpm-lock.yaml
- Modify: frontend/vite.config.ts
- Modify: frontend/src/types.ts
- Modify: frontend/src/api.ts
- Create: frontend/src/test/setup.ts
- Create: frontend/src/test/fixtures.ts
- Create: frontend/src/test/viewport.ts
- Create: frontend/src/api.test.ts

**Interfaces:**
- Produces: KnownAuditKind, AuditEvent with raw string kind, ApiResult<T>, putConfig(next): Promise<ApiResult<Config>>, and postAction(path): Promise<ApiResult<unknown>>.
- Produces: fixed typed fixtures consumed by every later task.

- [ ] **Step 1: Install the exact frontend test dependencies**

Run:

~~~bash
pnpm --dir frontend add -D vitest@^3.2.7 jsdom@^26.1.0 @testing-library/react@^16.3.0 @testing-library/user-event@^14.6.1 @testing-library/jest-dom@^6.6.3
~~~

Expected: frontend/package.json and the root pnpm-lock.yaml change; pnpm exits 0.

- [ ] **Step 2: Configure frontend and root test scripts**

Replace the frontend scripts with:

~~~json
{
  "dev": "vite",
  "build": "tsc --noEmit && vite build",
  "test": "vitest run",
  "test:watch": "vitest",
  "preview": "vite preview"
}
~~~

Replace the root scripts with this complete block:

~~~json
{
  "pipeline": "tsx src/pipeline.ts",
  "tick": "tsx src/executor-loop.ts",
  "serve": "tsx src/server.ts",
  "seed": "tsx scripts/seed-demo.ts",
  "ensure-stops": "tsx scripts/ensure-stops.ts",
  "ensure-stops:apply": "tsx scripts/ensure-stops.ts --apply",
  "preflight": "tsx scripts/preflight.ts",
  "test:backend": "vitest run",
  "test:frontend": "pnpm --dir frontend test",
  "test": "pnpm test:backend && pnpm test:frontend",
  "typecheck": "tsc --noEmit",
  "build:frontend": "cd frontend && pnpm install && pnpm build"
}
~~~

Change frontend/vite.config.ts to:

~~~ts
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:4310',
    },
  },
  build: {
    outDir: 'dist',
  },
  test: {
    environment: 'jsdom',
    environmentOptions: { jsdom: { url: 'http://localhost/' } },
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    clearMocks: true,
    restoreMocks: true,
    unstubGlobals: true,
  },
});
~~~

- [ ] **Step 3: Add deterministic test setup and viewport helpers**

Create frontend/src/test/setup.ts:

~~~ts
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

const initialWidth = window.innerWidth;
const initialHeight = window.innerHeight;
const initialMatchMedia = window.matchMedia;

afterEach(() => {
  cleanup();
  localStorage.clear();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: initialWidth });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: initialHeight });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: initialMatchMedia,
  });
  window.dispatchEvent(new Event('resize'));
});
~~~

Create frontend/src/test/viewport.ts:

~~~ts
export function setViewport(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string): MediaQueryList => {
      const min = /min-width:\s*(\d+)px/.exec(query);
      const max = /max-width:\s*(\d+)px/.exec(query);
      const matches =
        (min === null || width >= Number(min[1])) &&
        (max === null || width <= Number(max[1]));
      return {
        matches,
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => true,
      };
    },
  });
  window.dispatchEvent(new Event('resize'));
}
~~~

- [ ] **Step 4: Write failing API contract tests**

Create frontend/src/api.test.ts:

~~~ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchAudit, postAction, putConfig } from './api';
import { configFixture } from './test/fixtures';

describe('API normalization', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('preserves known counterfactual and unknown audit kinds', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({
        items: [
          { ts: '2026-07-12T14:00:00.000Z', kind: 'counterfactual', data: { ticker: 'AMD' } },
          { ts: '2026-07-12T14:01:00.000Z', kind: 'broker_heartbeat', data: { ok: true } },
        ],
      }), { status: 200 }),
    );

    await expect(fetchAudit()).resolves.toEqual([
      { ts: '2026-07-12T14:00:00.000Z', kind: 'counterfactual', data: { ticker: 'AMD' } },
      { ts: '2026-07-12T14:01:00.000Z', kind: 'broker_heartbeat', data: { ok: true } },
    ]);
  });

  it('returns the saved configuration from PUT', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify(configFixture), { status: 200 }),
    );

    await expect(putConfig(configFixture)).resolves.toEqual({
      ok: true,
      data: configFixture,
    });
  });

  it('surfaces backend validation text from PUT', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: 'Confidence must be between 0 and 1.' }), {
        status: 400,
      }),
    );

    await expect(putConfig(configFixture)).resolves.toEqual({
      ok: false,
      error: 'Confidence must be between 0 and 1.',
    });
  });

  it('states that no order was confirmed after an execution network failure', async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(postAction('/api/executor/tick')).resolves.toEqual({
      ok: false,
      error: 'Failed to fetch',
    });
  });
});
~~~

Run:

~~~bash
pnpm --dir frontend test -- src/api.test.ts
~~~

Expected: FAIL because the test setup, raw audit kind, discriminated mutation result, and fixtures do not exist yet.

- [ ] **Step 5: Synchronize frontend domain types**

In frontend/src/types.ts, retain all current interfaces not shown and make these exact replacements/additions:

~~~ts
export interface SizingAttribution {
  baseNotional: number;
  weightedConviction: number;
  volScalar: number;
  floor: number;
  scalars: Record<string, number>;
  product: number;
  leaveOneOut: Record<string, number>;
}

export interface ThesisEntry {
  ticker: string;
  direction: 'long' | 'short';
  weightedConviction: number;
  limitBand: { low: number; high: number };
  targetNotionalUsd: number;
  narrative: string;
  invalidationConditions: string[];
  sizing?: SizingAttribution;
}

export interface Thesis {
  date: string;
  kind: 'offhours' | 'rth';
  generatedAt: string;
  expiresAt: string;
  entries: ThesisEntry[];
  skipped: { ticker: string; reason: string }[];
  regime?: {
    state: string;
    longScalar: number;
    shortScalar: number;
    volScalar: number;
    thresholdBump: number;
  };
}

export interface BrokerOrder {
  id: string;
  ticker: string;
  side: 'buy' | 'sell';
  qty: number;
  type?: string;
  limitPrice: number;
  stopPrice?: number;
  timeInForce?: string;
  status: string;
  submittedAt: string;
  clientOrderId?: string;
  filledQty?: number;
}

export const KNOWN_AUDIT_KINDS = [
  'nomination',
  'candidates',
  'verdict',
  'thesis',
  'tick',
  'proposed_order',
  'order_placed',
  'order_rejected',
  'exit',
  'counterfactual',
  'halt',
  'resume',
  'error',
] as const;

export type KnownAuditKind = (typeof KNOWN_AUDIT_KINDS)[number];

export interface AuditEvent {
  ts: string;
  kind: string;
  data: unknown;
}
~~~

- [ ] **Step 6: Add typed fixtures**

Create frontend/src/test/fixtures.ts with fixed 2026-07-12 values, satisfies checks, and no unsafe whole-object casts:

~~~ts
import type {
  AuditEvent,
  BacktestResponse,
  CandidateFile,
  Config,
  OrdersResponse,
  PositionsResponse,
  StatusResponse,
  Thesis,
  VerdictFile,
} from '../types';

export const configFixture = {
  mode: 'paper',
  live_trading_acknowledged: false,
  universe: {
    nominations_per_agent: 3,
    max_candidates: 12,
    min_price: 5,
    min_avg_dollar_volume: 20_000_000,
    exclude: ['GME'],
  },
  sessions: { premarket: true, afterhours: true, regularhours: false },
  agent_weights: { fundamental: 1, technical: 1, macro: 1, sentiment: 1, bear: 1 },
  conviction_threshold: 0.7,
  quorum: 4,
  min_agreeing: 2,
  max_position_pct: 0.1,
  max_daily_deploy_pct: 0.3,
  max_order_notional_usd: 5_000,
  max_spread_bps: 40,
  max_chase_pct: 0.02,
  max_drop_pct: 0.03,
  target_vol_pct: 0.02,
  max_position_loss_pct: 0.04,
  daily_loss_halt_pct: 0.05,
  data_feed: 'iex',
  max_quote_age_sec: 30,
  executor_interval_min: 5,
  thesis_run_time_et: '16:15',
  model: { analysts: 'claude-sonnet', synthesizer: 'claude-sonnet', executor: 'rules' },
} satisfies Config;

export const statusFixture = {
  mode: 'paper',
  session: 'afterhours',
  halt: null,
  equity: 100_000,
} satisfies StatusResponse;

export const candidatesFixture = {
  date: '2026-07-12',
  candidates: [
    {
      ticker: 'AMD',
      nominatedBy: [{ analyst: 'technical', reason: 'Relative strength remained positive.' }],
      lastPrice: 172.4,
      avgDollarVolume20d: 1_200_000_000,
    },
    {
      ticker: 'WBD',
      nominatedBy: [{ analyst: 'fundamental', reason: 'Valuation screened below peers.' }],
      lastPrice: 11.2,
      avgDollarVolume20d: 90_000_000,
    },
  ],
  rejected: [{ ticker: 'GME', reason: 'Excluded by universe configuration.' }],
} satisfies CandidateFile;

export const verdictsFixture = {
  date: '2026-07-12',
  droppedAnalysts: [],
  verdicts: [
    {
      analyst: 'fundamental',
      ticker: 'AMD',
      direction: 'long',
      conviction: 0.78,
      horizon: 'weeks',
      evidence: ['Free cash flow remained positive.'],
      invalidation_conditions: ['Guidance is reduced.'],
    },
    {
      analyst: 'technical',
      ticker: 'AMD',
      direction: 'long',
      conviction: 0.82,
      horizon: 'days',
      evidence: ['Price held above the 20-day average.'],
      invalidation_conditions: ['Price closes below the 20-day average.'],
    },
    {
      analyst: 'fundamental',
      ticker: 'WBD',
      direction: 'long',
      conviction: 0.61,
      horizon: 'weeks',
      evidence: ['Valuation is below the sector median.'],
      invalidation_conditions: ['Leverage rises.'],
    },
    ...(['technical', 'macro', 'sentiment', 'bear'] as const).map((analyst) => ({
      analyst,
      ticker: 'WBD',
      direction: 'none' as const,
      conviction: 0.5,
      horizon: 'days' as const,
      evidence: ['No qualifying directional evidence was recorded.'],
      invalidation_conditions: [],
    })),
  ],
} satisfies VerdictFile;

export const offhoursPlanFixture = {
  date: '2026-07-12',
  kind: 'offhours',
  generatedAt: '2026-07-12T20:15:00.000Z',
  expiresAt: '2026-07-13T13:30:00.000Z',
  entries: [
    {
      ticker: 'AMD',
      direction: 'long',
      weightedConviction: 0.8,
      limitBand: { low: 170, high: 173 },
      targetNotionalUsd: 4_000,
      narrative: 'Two recorded analyst views supported a long position.',
      invalidationConditions: ['Price closes below 170.'],
    },
  ],
  skipped: [{ ticker: 'WBD', reason: '1 of 2 required analysts agreed.' }],
} satisfies Thesis;

export const rthPlanFixture = {
  ...offhoursPlanFixture,
  kind: 'rth',
  generatedAt: '2026-07-12T14:00:00.000Z',
  expiresAt: '2026-07-12T20:00:00.000Z',
} satisfies Thesis;

export const positionsFixture = {
  positions: [
    {
      ticker: 'AMD',
      qty: 20,
      avgEntryPrice: 168,
      marketValue: 3_448,
      unrealizedPl: 88,
      side: 'long',
    },
  ],
} satisfies PositionsResponse;

export const ordersFixture = {
  orders: [
    {
      id: 'order-1',
      ticker: 'AMD',
      side: 'buy',
      qty: 20,
      type: 'limit',
      limitPrice: 172.4,
      timeInForce: 'day',
      status: 'filled',
      submittedAt: '2026-07-12T14:05:00.000Z',
      clientOrderId: 'entry-amd-1',
      filledQty: 20,
    },
  ],
} satisfies OrdersResponse;

export const auditFixture = [
  {
    ts: '2026-07-12T20:15:00.000Z',
    kind: 'thesis',
    data: { entries: 1, skipped: 1 },
  },
  {
    ts: '2026-07-12T20:20:00.000Z',
    kind: 'order_rejected',
    data: { ticker: 'WBD', reason: 'Spread exceeded 40 bps.' },
  },
] satisfies AuditEvent[];

export const backtestFixture = {
  available: true,
  tag: 'july-sweep',
  generatedAt: '2026-07-12T12:00:00.000Z',
  tradeLogCell: 't070',
  cells: [
    {
      cell: 't070',
      threshold: 0.7,
      bear: 0.5,
      abstained: 3,
      ordersPlaced: 4,
      ordersFilled: 3,
      trades: 3,
      netPnlUsd: 125,
    },
  ],
  trades: [
    {
      day: '2026-07-10',
      stratum: 'base',
      ticker: 'AMD',
      side: 'buy',
      qty: 10,
      entryPrice: 168,
      exitPrice: 171,
      pnlUsd: 30,
      exitReason: 'target',
    },
  ],
} satisfies BacktestResponse;
~~~

- [ ] **Step 7: Implement discriminated API results and raw audit kinds**

Add and use this contract in frontend/src/api.ts:

~~~ts
export type ApiResult<T> =
  | { ok: true; data: T; message?: string }
  | { ok: false; error: string };

export async function fetchAudit(limit = 100): Promise<AuditEvent[]> {
  const raw = await getJson('/api/audit?limit=' + limit);
  const arr = Array.isArray(raw)
    ? raw
    : isObj(raw) && Array.isArray(raw.items)
      ? raw.items
      : isObj(raw) && Array.isArray(raw.events)
        ? raw.events
        : [];
  return arr.flatMap((event): AuditEvent[] => {
    if (!isObj(event)) return [];
    return [{
      ts: typeof event.ts === 'string' ? event.ts : '',
      kind: typeof event.kind === 'string' ? event.kind : 'unknown',
      data: event.data,
    }];
  });
}

export async function fetchThesis(kind: 'offhours' | 'rth' = 'offhours'): Promise<Thesis | null> {
  const raw = await getJson('/api/thesis?kind=' + kind);
  if (!isObj(raw) || !Array.isArray(raw.entries)) return null;
  return {
    date: typeof raw.date === 'string' ? raw.date : '',
    kind: raw.kind === 'rth' ? 'rth' : 'offhours',
    generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : '',
    expiresAt: typeof raw.expiresAt === 'string' ? raw.expiresAt : '',
    entries: raw.entries as Thesis['entries'],
    skipped: Array.isArray(raw.skipped) ? raw.skipped as Thesis['skipped'] : [],
    regime: isObj(raw.regime) ? raw.regime as unknown as Thesis['regime'] : undefined,
  };
}

export async function putConfig(next: unknown): Promise<ApiResult<Config>> {
  try {
    const res = await fetch('/api/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(next),
    });
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const message = isObj(body) && typeof body.error === 'string'
        ? body.error
        : 'HTTP ' + res.status;
      return { ok: false, error: message };
    }
    if (!isObj(body) || typeof body.mode !== 'string') {
      return { ok: false, error: 'The server returned an invalid configuration.' };
    }
    return { ok: true, data: body as unknown as Config };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function postAction(
  path: '/api/pipeline/run' | '/api/executor/tick' | '/api/halt' | '/api/resume',
): Promise<ApiResult<unknown>> {
  try {
    const res = await fetch(path, { method: 'POST' });
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const message = isObj(body) && typeof body.error === 'string'
        ? body.error
        : 'HTTP ' + res.status;
      return { ok: false, error: message };
    }
    const message = isObj(body) && typeof body.message === 'string' ? body.message : undefined;
    return { ok: true, data: body, message };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
~~~

Delete the AUDIT_KINDS coercion and remove AuditKind from the imports. Keep isMissingKeysError exported because OperationalHeader will use it to distinguish missing credentials.

- [ ] **Step 8: Run contract tests and the full baseline**

Run:

~~~bash
pnpm --dir frontend test -- src/api.test.ts
pnpm --dir frontend build
pnpm typecheck
pnpm test
~~~

Expected: api.test.ts passes; frontend build passes; root typecheck passes; 579 existing backend tests and the new frontend tests pass.

- [ ] **Step 9: Commit the harness and contracts**

~~~bash
git add frontend/package.json package.json pnpm-lock.yaml frontend/vite.config.ts frontend/src/types.ts frontend/src/api.ts frontend/src/api.test.ts frontend/src/test
git commit -m "test: add frontend contracts and harness"
~~~

---

### Task 2: Polling, Stale State, and Mutation Controller

**Files:**
- Create: frontend/src/app/operatorState.ts
- Create: frontend/src/app/operatorState.test.ts
- Create: frontend/src/app/useOperatorController.ts
- Create: frontend/src/app/useOperatorController.test.tsx

**Interfaces:**
- Consumes: ApiResult<T> and all fetch functions from Task 1.
- Produces: OperatorSnapshot, PollingState, ActionState, OperatorController, applyPoll(), and useOperatorController().

- [ ] **Step 1: Write failing pure-state tests**

Create frontend/src/app/operatorState.test.ts:

~~~ts
import { describe, expect, it } from 'vitest';
import { configFixture, statusFixture } from '../test/fixtures';
import {
  applyPoll,
  createInitialOperatorState,
  type PollResults,
} from './operatorState';

function failure(error: string) {
  return { ok: false as const, error };
}

function results(overrides: Partial<PollResults> = {}): PollResults {
  const failed = failure('not supplied');
  return {
    status: failed,
    candidates: failed,
    thesis: failed,
    thesisRth: failed,
    verdicts: failed,
    positions: failed,
    orders: failed,
    audit: failed,
    config: failed,
    backtest: failed,
    ...overrides,
  };
}

describe('applyPoll', () => {
  it('advances full-success time only when every resource succeeds', () => {
    const all: PollResults = {
      status: { ok: true, value: statusFixture },
      candidates: { ok: true, value: null },
      thesis: { ok: true, value: null },
      thesisRth: { ok: true, value: null },
      verdicts: { ok: true, value: null },
      positions: { ok: true, value: { positions: [] } },
      orders: { ok: true, value: { orders: [] } },
      audit: { ok: true, value: [] },
      config: { ok: true, value: configFixture },
      backtest: { ok: true, value: null },
    };

    const next = applyPoll(createInitialOperatorState(), all, 1_000);

    expect(next.polling.lastFullSuccessAt).toBe(1_000);
    expect(next.polling.stale).toBe(false);
    expect(next.polling.connectivity).toBe('online');
  });

  it('retains last-known-good data and labels a partial refresh stale', () => {
    const initial = createInitialOperatorState();
    const seeded = {
      ...initial,
      data: { ...initial.data, status: statusFixture },
    };

    const next = applyPoll(seeded, results({
      status: failure('broker timeout'),
      config: { ok: true, value: configFixture },
    }), 2_000);

    expect(next.data.status).toEqual(statusFixture);
    expect(next.polling.resources.status.state).toBe('stale');
    expect(next.polling.stale).toBe(true);
    expect(next.polling.lastFullSuccessAt).toBeNull();
  });

  it('marks all-rejected polls offline and recovers on a later success', () => {
    const offline = applyPoll(createInitialOperatorState(), results(), 3_000);
    expect(offline.polling.connectivity).toBe('offline');

    const recovered = applyPoll(offline, results({
      status: { ok: true, value: statusFixture },
    }), 4_000);
    expect(recovered.polling.connectivity).toBe('online');
    expect(recovered.polling.stale).toBe(true);
  });
});
~~~

Run:

~~~bash
pnpm --dir frontend test -- src/app/operatorState.test.ts
~~~

Expected: FAIL because operatorState.ts does not exist.

- [ ] **Step 2: Implement the pure operator state**

Create frontend/src/app/operatorState.ts with these complete public contracts and reducer rules:

~~~ts
import type {
  AuditEvent,
  BacktestResponse,
  CandidateFile,
  Config,
  OrdersResponse,
  PositionsResponse,
  StatusResponse,
  Thesis,
  VerdictFile,
} from '../types';

export interface OperatorSnapshot {
  status: StatusResponse | null;
  candidates: CandidateFile | null;
  thesis: Thesis | null;
  thesisRth: Thesis | null;
  verdicts: VerdictFile | null;
  positions: PositionsResponse;
  orders: OrdersResponse;
  audit: AuditEvent[];
  config: Config | null;
  backtest: BacktestResponse | null;
}

export type ResourceKey = keyof OperatorSnapshot;

export type ResourceResult<K extends ResourceKey> =
  | { ok: true; value: OperatorSnapshot[K] }
  | { ok: false; error: string };

export type PollResults = {
  [K in ResourceKey]: ResourceResult<K>;
};

export interface ResourceHealth {
  state: 'never' | 'fresh' | 'stale' | 'error';
  lastSuccessAt: number | null;
  error: string | null;
}

export interface PollingState {
  initialLoading: boolean;
  refreshing: boolean;
  connectivity: 'unknown' | 'online' | 'offline';
  stale: boolean;
  lastAttemptAt: number | null;
  lastFullSuccessAt: number | null;
  resources: Record<ResourceKey, ResourceHealth>;
}

export type OperatorAction = 'analysis' | 'executionCheck' | 'halt' | 'resume';

export type ActionState =
  | { phase: 'idle' }
  | { phase: 'pending'; startedAt: number }
  | { phase: 'success'; message: string; completedAt: number }
  | { phase: 'error'; message: string; completedAt: number };

export interface OperatorState {
  data: OperatorSnapshot;
  polling: PollingState;
  actions: Record<OperatorAction, ActionState>;
}

const resourceKeys: ResourceKey[] = [
  'status',
  'candidates',
  'thesis',
  'thesisRth',
  'verdicts',
  'positions',
  'orders',
  'audit',
  'config',
  'backtest',
];

function health(): ResourceHealth {
  return { state: 'never', lastSuccessAt: null, error: null };
}

export function createInitialOperatorState(): OperatorState {
  return {
    data: {
      status: null,
      candidates: null,
      thesis: null,
      thesisRth: null,
      verdicts: null,
      positions: { positions: [] },
      orders: { orders: [] },
      audit: [],
      config: null,
      backtest: null,
    },
    polling: {
      initialLoading: true,
      refreshing: false,
      connectivity: 'unknown',
      stale: false,
      lastAttemptAt: null,
      lastFullSuccessAt: null,
      resources: Object.fromEntries(resourceKeys.map((key) => [key, health()])) as Record<
        ResourceKey,
        ResourceHealth
      >,
    },
    actions: {
      analysis: { phase: 'idle' },
      executionCheck: { phase: 'idle' },
      halt: { phase: 'idle' },
      resume: { phase: 'idle' },
    },
  };
}

export function markRefreshing(state: OperatorState, at: number): OperatorState {
  return {
    ...state,
    polling: { ...state.polling, refreshing: true, lastAttemptAt: at },
  };
}

export function applyPoll(
  state: OperatorState,
  results: PollResults,
  at: number,
): OperatorState {
  const data = { ...state.data };
  const resources = { ...state.polling.resources };
  let fulfilled = 0;

  for (const key of resourceKeys) {
    const result = results[key];
    if (result.ok) {
      fulfilled += 1;
      data[key] = result.value as never;
      resources[key] = { state: 'fresh', lastSuccessAt: at, error: null };
    } else {
      const previous = resources[key];
      resources[key] = {
        state: previous.lastSuccessAt === null ? 'error' : 'stale',
        lastSuccessAt: previous.lastSuccessAt,
        error: result.error,
      };
    }
  }

  const allSucceeded = fulfilled === resourceKeys.length;
  return {
    ...state,
    data,
    polling: {
      initialLoading: false,
      refreshing: false,
      connectivity: fulfilled === 0 ? 'offline' : 'online',
      stale: !allSucceeded,
      lastAttemptAt: at,
      lastFullSuccessAt: allSucceeded ? at : state.polling.lastFullSuccessAt,
      resources,
    },
  };
}

export function setActionState(
  state: OperatorState,
  action: OperatorAction,
  next: ActionState,
): OperatorState {
  return { ...state, actions: { ...state.actions, [action]: next } };
}
~~~

Run:

~~~bash
pnpm --dir frontend test -- src/app/operatorState.test.ts
~~~

Expected: PASS.

- [ ] **Step 3: Write failing controller cadence and mutation tests**

Create frontend/src/app/useOperatorController.test.tsx:

~~~tsx
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiResult } from '../api';
import { statusFixture } from '../test/fixtures';
import type { OperatorAction, PollResults } from './operatorState';
import { useOperatorController, type OperatorApi } from './useOperatorController';

function rejectedPoll(error = 'offline'): PollResults {
  return Object.fromEntries(
    [
      'status', 'candidates', 'thesis', 'thesisRth', 'verdicts',
      'positions', 'orders', 'audit', 'config', 'backtest',
    ].map((key) => [key, { ok: false, error }]),
  ) as PollResults;
}

describe('useOperatorController', () => {
  afterEach(() => vi.useRealTimers());

  it('polls immediately, every ten seconds, and never overlaps', async () => {
    vi.useFakeTimers();
    let release: ((value: PollResults) => void) | undefined;
    const poll = vi.fn(() => new Promise<PollResults>((resolve) => { release = resolve; }));
    const api: OperatorApi = {
      poll,
      action: vi.fn<(
        action: OperatorAction,
      ) => Promise<ApiResult<unknown>>>(),
    };
    renderHook(() => useOperatorController(api));

    expect(poll).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(poll).toHaveBeenCalledTimes(1);

    await act(async () => { release?.(rejectedPoll()); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it('retains an action failure and does not imply an order was submitted', async () => {
    const api: OperatorApi = {
      poll: vi.fn().mockResolvedValue(rejectedPoll()),
      action: vi.fn().mockResolvedValue({ ok: false, error: 'Broker did not respond.' }),
    };
    const { result } = renderHook(() => useOperatorController(api));

    await act(async () => { await result.current.runAction('executionCheck'); });

    expect(result.current.actions.executionCheck).toMatchObject({
      phase: 'error',
      message: 'Execution check failed. Broker did not respond. No order was submitted.',
    });
  });

  it('keeps mutation success even if its follow-up refresh is stale', async () => {
    const poll = vi.fn()
      .mockResolvedValueOnce(rejectedPoll())
      .mockResolvedValueOnce({
        ...rejectedPoll('quote timeout'),
        status: { ok: true, value: statusFixture },
      });
    const api: OperatorApi = {
      poll,
      action: vi.fn().mockResolvedValue({ ok: true, data: {}, message: 'Execution complete.' }),
    };
    const { result } = renderHook(() => useOperatorController(api));

    await act(async () => { await result.current.runAction('executionCheck'); });

    expect(result.current.actions.executionCheck.phase).toBe('success');
    expect(result.current.polling.stale).toBe(true);
  });
});
~~~

Run:

~~~bash
pnpm --dir frontend test -- src/app/useOperatorController.test.tsx
~~~

Expected: FAIL because the controller does not exist.

- [ ] **Step 4: Implement the injected controller**

Create frontend/src/app/useOperatorController.ts. Use this public contract and exact endpoint map:

~~~ts
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchAudit,
  fetchBacktest,
  fetchCandidates,
  fetchConfig,
  fetchOrders,
  fetchPositions,
  fetchStatus,
  fetchThesis,
  fetchVerdicts,
  postAction,
  type ApiResult,
} from '../api';
import {
  applyPoll,
  createInitialOperatorState,
  markRefreshing,
  setActionState,
  type OperatorAction,
  type OperatorState,
  type PollResults,
} from './operatorState';

export interface OperatorApi {
  poll(): Promise<PollResults>;
  action(action: OperatorAction): Promise<ApiResult<unknown>>;
}

export interface OperatorController extends OperatorState {
  refresh(): Promise<void>;
  runAction(action: OperatorAction): Promise<void>;
}

const paths: Record<OperatorAction, Parameters<typeof postAction>[0]> = {
  analysis: '/api/pipeline/run',
  executionCheck: '/api/executor/tick',
  halt: '/api/halt',
  resume: '/api/resume',
};

function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

async function settlePoll(): Promise<PollResults> {
  const requests = {
    status: fetchStatus(),
    candidates: fetchCandidates(),
    thesis: fetchThesis('offhours'),
    thesisRth: fetchThesis('rth'),
    verdicts: fetchVerdicts(),
    positions: fetchPositions(),
    orders: fetchOrders(),
    audit: fetchAudit(200),
    config: fetchConfig(),
    backtest: fetchBacktest(),
  };
  const keys = Object.keys(requests) as (keyof typeof requests)[];
  const settled = await Promise.allSettled(keys.map((key) => requests[key]));
  return Object.fromEntries(settled.map((result, index) => {
    const key = keys[index];
    return [
      key,
      result.status === 'fulfilled'
        ? { ok: true, value: result.value }
        : { ok: false, error: errorText(result.reason) },
    ];
  })) as PollResults;
}

export const operatorApi: OperatorApi = {
  poll: settlePoll,
  action: (action) => postAction(paths[action]),
};

const labels: Record<OperatorAction, string> = {
  analysis: 'Analysis',
  executionCheck: 'Execution check',
  halt: 'Halt',
  resume: 'Resume',
};

const successMessages: Record<OperatorAction, string> = {
  analysis: 'Analysis started.',
  executionCheck: 'Execution check started.',
  halt: 'Trading halted.',
  resume: 'Trading resumed.',
};

function actionError(action: OperatorAction, error: string): string {
  const trimmed = error.trim();
  const cause = /[.!?]$/.test(trimmed) ? trimmed : trimmed + '.';
  const suffix = action === 'executionCheck' ? ' No order was submitted.' : '';
  return labels[action] + ' failed. ' + cause + suffix;
}

export function useOperatorController(
  api: OperatorApi = operatorApi,
  intervalMs = 10_000,
): OperatorController {
  const [state, setState] = useState(createInitialOperatorState);
  const inFlight = useRef(false);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setState((current) => markRefreshing(current, Date.now()));
    try {
      const results = await api.poll();
      if (mounted.current) setState((current) => applyPoll(current, results, Date.now()));
    } finally {
      inFlight.current = false;
    }
  }, [api]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, intervalMs);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
    };
  }, [intervalMs, refresh]);

  const runAction = useCallback(async (action: OperatorAction) => {
    const startedAt = Date.now();
    setState((current) => setActionState(current, action, { phase: 'pending', startedAt }));
    const result = await api.action(action);
    if (!mounted.current) return;
    if (!result.ok) {
      setState((current) => setActionState(current, action, {
        phase: 'error',
        message: actionError(action, result.error),
        completedAt: Date.now(),
      }));
      return;
    }
    setState((current) => setActionState(current, action, {
      phase: 'success',
      message: successMessages[action],
      completedAt: Date.now(),
    }));
    await refresh();
  }, [api, refresh]);

  return { ...state, refresh, runAction };
}
~~~

- [ ] **Step 5: Run controller and baseline checks**

Run:

~~~bash
pnpm --dir frontend test -- src/app/operatorState.test.ts src/app/useOperatorController.test.tsx
pnpm --dir frontend build
~~~

Expected: both test files and the frontend build pass. If StrictMode causes two initial polls in a test, keep the hook correct and render that test without a StrictMode wrapper.

- [ ] **Step 6: Commit polling and action state**

~~~bash
git add frontend/src/app
git commit -m "feat: preserve operator polling and action state"
~~~

---

### Task 3: Clinical Presentation Models

**Files:**
- Create: frontend/src/presentation/format.ts
- Create: frontend/src/presentation/candidates.ts
- Create: frontend/src/presentation/candidates.test.ts
- Create: frontend/src/presentation/audit.ts
- Create: frontend/src/presentation/audit.test.ts
- Create: frontend/src/presentation/positions.ts
- Create: frontend/src/presentation/positions.test.ts
- Create: frontend/src/presentation/backtest.ts
- Create: frontend/src/presentation/backtest.test.ts

**Interfaces:**
- Consumes: domain contracts and typed fixtures from Task 1.
- Produces: formatEtTimestamp(), formatRefreshAge(), CandidateDecisionRow, buildCandidateDecisionRows(), PresentedAuditEvent, presentAuditEvent(), RiskRejectionRow, buildRiskRejections(), humanizeBrokerStatus(), and buildBacktestPoints().

- [ ] **Step 1: Write candidate truthfulness tests**

Create frontend/src/presentation/candidates.test.ts:

~~~ts
import { describe, expect, it } from 'vitest';
import {
  candidatesFixture,
  configFixture,
  offhoursPlanFixture,
  verdictsFixture,
} from '../test/fixtures';
import { buildCandidateDecisionRows } from './candidates';

describe('buildCandidateDecisionRows', () => {
  it('uses recorded plan confidence for selected entries', () => {
    const rows = buildCandidateDecisionRows({
      candidates: candidatesFixture,
      verdicts: verdictsFixture,
      plan: offhoursPlanFixture,
      config: configFixture,
    });
    expect(rows.find((row) => row.symbol === 'AMD')).toMatchObject({
      panelPosition: 'long',
      agreeing: 2,
      requiredAgreeing: 2,
      confidence: 0.8,
      outcome: 'selected',
    });
  });

  it('does not reconstruct confidence for skipped candidates', () => {
    const rows = buildCandidateDecisionRows({
      candidates: candidatesFixture,
      verdicts: verdictsFixture,
      plan: offhoursPlanFixture,
      config: configFixture,
    });
    expect(rows.find((row) => row.symbol === 'WBD')).toMatchObject({
      panelPosition: 'long',
      agreeing: 1,
      confidence: null,
      confidenceText: 'Not recorded',
      outcome: 'not-selected',
      outcomeText: 'Not selected — 1 of 2 required analysts agreed.',
    });
  });
});
~~~

- [ ] **Step 2: Write audit, position, and backtest truthfulness tests**

Create frontend/src/presentation/audit.test.ts:

~~~ts
import { describe, expect, it } from 'vitest';
import { presentAuditEvent } from './audit';

describe('presentAuditEvent', () => {
  it('renders unknown kinds as unknown without relabeling them', () => {
    const event = presentAuditEvent({
      ts: '2026-07-12T14:00:00.000Z',
      kind: 'broker_heartbeat',
      data: { ok: true },
    });
    expect(event).toMatchObject({
      activity: 'Unknown event',
      stage: 'System',
      status: 'unknown',
      knownKind: false,
      rawKind: 'broker_heartbeat',
    });
  });

  it('states a closed-session execution skip clinically', () => {
    const event = presentAuditEvent({
      ts: '2026-07-12T14:00:00.000Z',
      kind: 'tick',
      data: { status: 'skipped', reason: 'market session is closed' },
    });
    expect(event.description).toBe(
      'Execution check skipped. The market session is closed. No order was evaluated.',
    );
  });
});
~~~

Create frontend/src/presentation/positions.test.ts:

~~~ts
import { describe, expect, it } from 'vitest';
import { buildRiskRejections, humanizeBrokerStatus } from './positions';

describe('position presentation', () => {
  it('uses ordinary broker status text', () => {
    expect(humanizeBrokerStatus('partially_filled')).toBe('Partially filled');
  });

  it('keeps only ET-today risk rejections', () => {
    const rows = buildRiskRejections([
      {
        ts: '2026-07-12T14:00:00.000Z',
        kind: 'order_rejected',
        data: { ticker: 'AMD', reason: 'Spread exceeded 40 bps.' },
      },
      {
        ts: '2026-07-11T14:00:00.000Z',
        kind: 'order_rejected',
        data: { ticker: 'WBD', reason: 'Quote was stale.' },
      },
    ], new Date('2026-07-12T18:00:00.000Z'));
    expect(rows.map((row) => row.symbol)).toEqual(['AMD']);
  });
});
~~~

Create frontend/src/presentation/backtest.test.ts:

~~~ts
import { describe, expect, it } from 'vitest';
import { backtestFixture } from '../test/fixtures';
import { buildBacktestPoints } from './backtest';

describe('buildBacktestPoints', () => {
  it('maps only returned cells into chart values', () => {
    expect(buildBacktestPoints(backtestFixture.cells ?? [])).toEqual([
      { key: 't070', threshold: 0.7, pnl: 125 },
    ]);
  });
});
~~~

Run:

~~~bash
pnpm --dir frontend test -- src/presentation
~~~

Expected: FAIL because the presentation modules do not exist.

- [ ] **Step 3: Implement formatting and candidate derivation**

Create frontend/src/presentation/format.ts:

~~~ts
export function formatEtTimestamp(iso: string): string {
  const value = new Date(iso);
  if (!Number.isFinite(value.getTime())) return 'Not recorded';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(value) + ' ET';
}

export function formatRefreshAge(at: number | null, now = Date.now()): string {
  if (at === null) return 'No successful refresh';
  const seconds = Math.max(0, Math.floor((now - at) / 1_000));
  if (seconds < 60) return seconds + 's ago';
  const minutes = Math.floor(seconds / 60);
  return minutes + 'm ago';
}

export function formatUsd(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'Not available';
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

export function formatPercent(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'Not recorded';
  return (value * 100).toFixed(0) + '%';
}

export function sentenceCase(value: string): string {
  const spaced = value.replace(/[_-]+/g, ' ').trim();
  return spaced === '' ? 'Not recorded' : spaced[0].toUpperCase() + spaced.slice(1);
}
~~~

Create frontend/src/presentation/candidates.ts:

~~~ts
import type {
  CandidateFile,
  Config,
  Direction,
  Thesis,
  ThesisEntry,
  Verdict,
  VerdictFile,
} from '../types';
import { formatPercent } from './format';

export interface CandidateDecisionRow {
  symbol: string;
  panelPosition: Direction;
  agreeing: number;
  requiredAgreeing: number | null;
  confidence: number | null;
  requiredConfidence: number | null;
  confidenceText: string;
  outcome: 'selected' | 'not-selected' | 'pending';
  outcomeText: string;
  verdicts: readonly Verdict[];
  entry: ThesisEntry | null;
  skipReason: string | null;
}

function plurality(verdicts: readonly Verdict[]): Direction {
  const long = verdicts.filter((item) => item.direction === 'long').length;
  const short = verdicts.filter((item) => item.direction === 'short').length;
  if (long === short) return 'none';
  return long > short ? 'long' : 'short';
}

export function buildCandidateDecisionRows(input: {
  candidates: CandidateFile | null;
  verdicts: VerdictFile | null;
  plan: Thesis | null;
  config: Config | null;
}): CandidateDecisionRow[] {
  const symbols = new Set(input.candidates?.candidates.map((item) => item.ticker) ?? []);
  input.verdicts?.verdicts.forEach((verdict) => symbols.add(verdict.ticker));
  input.plan?.entries.forEach((entry) => symbols.add(entry.ticker));
  input.plan?.skipped.forEach((entry) => symbols.add(entry.ticker));

  return [...symbols].sort().map((symbol) => {
    const verdicts = input.verdicts?.verdicts.filter((item) => item.ticker === symbol) ?? [];
    const entry = input.plan?.entries.find((item) => item.ticker === symbol) ?? null;
    const skipped = input.plan?.skipped.find((item) => item.ticker === symbol) ?? null;
    const panelPosition = entry?.direction ?? plurality(verdicts);
    const agreeing = panelPosition === 'none'
      ? 0
      : verdicts.filter((item) => item.direction === panelPosition).length;
    const outcome = entry ? 'selected' : skipped ? 'not-selected' : 'pending';
    const outcomeText = entry
      ? 'Selected for the trading plan'
      : skipped
        ? 'Not selected — ' + skipped.reason
        : 'Decision pending';
    return {
      symbol,
      panelPosition,
      agreeing,
      requiredAgreeing: input.config?.min_agreeing ?? null,
      confidence: entry?.weightedConviction ?? null,
      requiredConfidence: input.config?.conviction_threshold ?? null,
      confidenceText: entry ? formatPercent(entry.weightedConviction) : 'Not recorded',
      outcome,
      outcomeText,
      verdicts,
      entry,
      skipReason: skipped?.reason ?? null,
    };
  });
}
~~~

- [ ] **Step 4: Implement audit, position, and backtest presentation**

Create frontend/src/presentation/audit.ts:

~~~ts
import { KNOWN_AUDIT_KINDS, type AuditEvent, type KnownAuditKind } from '../types';
import { formatEtTimestamp, sentenceCase } from './format';

export type ActivityStatus =
  | 'completed'
  | 'skipped'
  | 'rejected'
  | 'failed'
  | 'halted'
  | 'pending'
  | 'unknown';

export interface PresentedAuditEvent {
  id: string;
  timestamp: string;
  activity: string;
  stage: string;
  status: ActivityStatus;
  description: string;
  fields: readonly { label: string; value: string }[];
  rawJson: string;
  rawKind: string;
  knownKind: boolean;
}

const activity: Record<KnownAuditKind, [string, string]> = {
  nomination: ['Nomination', 'Analysis'],
  candidates: ['Candidate selection', 'Analysis'],
  verdict: ['Analyst review', 'Analysis'],
  thesis: ['Trading plan', 'Analysis'],
  tick: ['Execution check', 'Execution'],
  proposed_order: ['Order review', 'Execution'],
  order_placed: ['Order submitted', 'Broker'],
  order_rejected: ['Order rejected', 'Risk checks'],
  exit: ['Position exit', 'Execution'],
  counterfactual: ['Sizing analysis', 'Analysis'],
  halt: ['Trading halted', 'Controls'],
  resume: ['Trading resumed', 'Controls'],
  error: ['System error', 'System'],
};

function objectData(data: unknown): Record<string, unknown> {
  return typeof data === 'object' && data !== null && !Array.isArray(data)
    ? data as Record<string, unknown>
    : {};
}

function classify(kind: string, data: Record<string, unknown>): ActivityStatus {
  if (kind === 'error') return 'failed';
  if (kind === 'order_rejected') return 'rejected';
  if (kind === 'halt') return 'halted';
  if (kind === 'proposed_order') return 'pending';
  if (data.status === 'skipped' || data.skipped === true) return 'skipped';
  if (!KNOWN_AUDIT_KINDS.includes(kind as KnownAuditKind)) return 'unknown';
  return 'completed';
}

function completeSentence(value: string): string {
  const text = sentenceCase(value);
  return /[.!?]$/.test(text) ? text : text + '.';
}

function describe(kind: string, data: Record<string, unknown>): string {
  if (
    kind === 'tick' &&
    (data.status === 'skipped' || data.skipped === true) &&
    typeof data.reason === 'string' &&
    /closed/i.test(data.reason)
  ) {
    return 'Execution check skipped. The market session is closed. No order was evaluated.';
  }
  const reason = typeof data.reason === 'string' ? data.reason : null;
  const message = typeof data.message === 'string' ? data.message : null;
  const name = KNOWN_AUDIT_KINDS.includes(kind as KnownAuditKind)
    ? activity[kind as KnownAuditKind][0]
    : 'Unknown event';
  if (reason) return name + '. ' + completeSentence(reason);
  if (message) return name + '. ' + completeSentence(message);
  return name + ' recorded.';
}

export function presentAuditEvent(event: AuditEvent, index = 0): PresentedAuditEvent {
  const data = objectData(event.data);
  const knownKind = KNOWN_AUDIT_KINDS.includes(event.kind as KnownAuditKind);
  const [name, stage] = knownKind ? activity[event.kind as KnownAuditKind] : ['Unknown event', 'System'];
  return {
    id: event.ts + ':' + event.kind + ':' + index,
    timestamp: formatEtTimestamp(event.ts),
    activity: name,
    stage,
    status: classify(event.kind, data),
    description: describe(event.kind, data),
    fields: Object.entries(data).map(([label, value]) => ({
      label: sentenceCase(label),
      value: typeof value === 'string' ? value : JSON.stringify(value) ?? 'Not recorded',
    })),
    rawJson: JSON.stringify(event, null, 2),
    rawKind: event.kind,
    knownKind,
  };
}
~~~

Create frontend/src/presentation/positions.ts:

~~~ts
import type { AuditEvent } from '../types';
import { formatEtTimestamp, sentenceCase } from './format';

export interface RiskRejectionRow {
  id: string;
  symbol: string;
  reason: string;
  timestamp: string;
  raw: AuditEvent;
}

function etDate(value: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(value);
}

export function humanizeBrokerStatus(raw: string): string {
  return sentenceCase(raw);
}

export function buildRiskRejections(
  events: readonly AuditEvent[],
  now = new Date(),
): RiskRejectionRow[] {
  const today = etDate(now);
  return events.flatMap((event, index): RiskRejectionRow[] => {
    if (event.kind !== 'order_rejected' || etDate(new Date(event.ts)) !== today) return [];
    const data = typeof event.data === 'object' && event.data !== null
      ? event.data as Record<string, unknown>
      : {};
    return [{
      id: event.ts + ':' + index,
      symbol: typeof data.ticker === 'string' ? data.ticker : 'Not recorded',
      reason: typeof data.reason === 'string' ? data.reason : 'Reason not recorded.',
      timestamp: formatEtTimestamp(event.ts),
      raw: event,
    }];
  });
}
~~~

Create frontend/src/presentation/backtest.ts:

~~~ts
import type { BacktestCell } from '../types';

export interface BacktestPoint {
  key: string;
  threshold: number;
  pnl: number;
}

export function buildBacktestPoints(cells: readonly BacktestCell[]): BacktestPoint[] {
  return cells
    .filter((cell) => Number.isFinite(cell.threshold) && Number.isFinite(cell.netPnlUsd))
    .map((cell) => ({ key: cell.cell, threshold: cell.threshold, pnl: cell.netPnlUsd }))
    .sort((a, b) => a.threshold - b.threshold);
}
~~~

- [ ] **Step 5: Run presentation tests and commit**

Run:

~~~bash
pnpm --dir frontend test -- src/presentation
pnpm --dir frontend build
~~~

Expected: all four presentation test files pass and the build passes.

Commit:

~~~bash
git add frontend/src/presentation
git commit -m "feat: add clinical trading presentation models"
~~~

---

### Task 4: Structural Pane, Table, and Status Primitives

**Files:**
- Create: frontend/src/components/workspace/Pane.tsx
- Create: frontend/src/components/workspace/Pane.test.tsx
- Create: frontend/src/components/workspace/DataTable.tsx
- Create: frontend/src/components/workspace/DataTable.test.tsx
- Create: frontend/src/components/workspace/StatusMessage.tsx
- Create: frontend/src/components/workspace/StatusMessage.test.tsx

**Interfaces:**
- Consumes: ReactNode only; shared workspace primitives remain domain-agnostic and never fetch.
- Produces: Pane, PaneTab, DataTable, DataColumn<T>, StatusMessage, and StatusTone.

- [ ] **Step 1: Write failing semantic primitive tests**

Create frontend/src/components/workspace/StatusMessage.test.tsx:

~~~tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatusMessage } from './StatusMessage';

describe('StatusMessage', () => {
  it('announces errors assertively and includes visible text', () => {
    render(
      <StatusMessage tone="error" announce="assertive">
        Refresh failed. Showing last-known data.
      </StatusMessage>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Refresh failed. Showing last-known data.',
    );
  });

  it('does not create a live region when announcement is off', () => {
    render(<StatusMessage tone="empty">No open positions.</StatusMessage>);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByText('No open positions.')).toBeVisible();
  });
});
~~~

Create frontend/src/components/workspace/Pane.test.tsx:

~~~tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Pane } from './Pane';

describe('Pane', () => {
  it('exposes a named region and accessible detail tabs', async () => {
    const onTabChange = vi.fn();
    render(
      <Pane
        id="candidate-detail"
        title="Candidate detail"
        tabs={[
          { id: 'summary', label: 'Summary' },
          { id: 'evidence', label: 'Evidence' },
          { id: 'rules', label: 'Rules' },
        ]}
        activeTab="summary"
        onTabChange={onTabChange}
      >
        Decision detail
      </Pane>,
    );

    expect(screen.getByRole('region', { name: 'Candidate detail' })).toBeVisible();
    expect(screen.getByRole('tab', { name: 'Summary' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await userEvent.click(screen.getByRole('tab', { name: 'Evidence' }));
    expect(onTabChange).toHaveBeenCalledWith('evidence');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Decision detail');
  });
});
~~~

Create frontend/src/components/workspace/DataTable.test.tsx:

~~~tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DataTable, type DataColumn } from './DataTable';

interface Row {
  symbol: string;
  price: number;
}

const columns: DataColumn<Row>[] = [
  { id: 'symbol', header: 'Symbol', cell: (row) => row.symbol },
  {
    id: 'price',
    header: 'Price',
    cell: (row) => row.price.toFixed(2),
    align: 'right',
    mobilePriority: 'secondary',
  },
];

describe('DataTable', () => {
  it('uses real headers and supports keyboard row selection', async () => {
    const onSelect = vi.fn();
    render(
      <DataTable
        ariaLabel="Candidate monitor"
        rows={[{ symbol: 'AMD', price: 172.4 }]}
        columns={columns}
        rowKey={(row) => row.symbol}
        rowLabel={(row) => 'Inspect ' + row.symbol}
        emptyMessage="No candidates were recorded."
        onSelect={onSelect}
      />,
    );

    expect(screen.getByRole('columnheader', { name: 'Symbol' })).toBeVisible();
    expect(screen.getByRole('table', { name: 'Candidate monitor' })).toBeVisible();
    const row = screen.getByRole('row', { name: /Inspect AMD/ });
    row.focus();
    await userEvent.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledWith({ symbol: 'AMD', price: 172.4 });
  });

  it('renders one explicit empty row', () => {
    render(
      <DataTable
        ariaLabel="Candidate monitor"
        rows={[]}
        columns={columns}
        rowKey={(row) => row.symbol}
        emptyMessage="No candidates were recorded."
      />,
    );
    expect(screen.getByText('No candidates were recorded.')).toBeVisible();
  });

  it('exposes expanded state and a full-width detail row', async () => {
    const onToggleExpanded = vi.fn();
    render(
      <DataTable
        ariaLabel="Orders"
        rows={[{ symbol: 'AMD', price: 172.4 }]}
        columns={columns}
        rowKey={(row) => row.symbol}
        emptyMessage="No orders were submitted today."
        expandedKey="AMD"
        onToggleExpanded={onToggleExpanded}
        renderExpanded={(row) => <pre>{row.symbol + ' raw'}</pre>}
      />,
    );
    const row = screen.getByRole('row', { name: /AMD/ });
    expect(row).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('AMD raw')).toBeVisible();
    await userEvent.click(row);
    expect(onToggleExpanded).toHaveBeenCalledWith({ symbol: 'AMD', price: 172.4 });
  });
});
~~~

Run:

~~~bash
pnpm --dir frontend test -- src/components/workspace/StatusMessage.test.tsx src/components/workspace/Pane.test.tsx src/components/workspace/DataTable.test.tsx
~~~

Expected: FAIL because the three primitives do not exist.

- [ ] **Step 2: Implement StatusMessage**

Create frontend/src/components/workspace/StatusMessage.tsx:

~~~tsx
import type { ReactNode } from 'react';

export type StatusTone = 'loading' | 'stale' | 'empty' | 'success' | 'warning' | 'error';

export interface StatusMessageProps {
  tone: StatusTone;
  children: ReactNode;
  announce?: 'polite' | 'assertive' | 'off';
}

export function StatusMessage({
  tone,
  children,
  announce = 'off',
}: StatusMessageProps) {
  const role = announce === 'assertive' ? 'alert' : announce === 'polite' ? 'status' : undefined;
  return (
    <div
      className={'status-message status-message--' + tone}
      role={role}
      aria-live={announce === 'off' ? undefined : announce}
    >
      {children}
    </div>
  );
}
~~~

- [ ] **Step 3: Implement Pane tabs as a controlled primitive**

Create frontend/src/components/workspace/Pane.tsx:

~~~tsx
import type { ReactNode } from 'react';

export interface PaneTab {
  id: string;
  label: string;
}

export interface PaneProps {
  id: string;
  title: string;
  ariaLabel?: string;
  subtitle?: ReactNode;
  toolbar?: ReactNode;
  tabs?: readonly PaneTab[];
  activeTab?: string;
  onTabChange?(id: string): void;
  overflow?: 'auto' | 'hidden' | 'visible';
  className?: string;
  children: ReactNode;
}

export function Pane({
  id,
  title,
  ariaLabel,
  subtitle,
  toolbar,
  tabs,
  activeTab,
  onTabChange,
  overflow = 'auto',
  className = '',
  children,
}: PaneProps) {
  const headingId = id + '-title';
  const panelId = id + '-panel';
  return (
    <section
      className={'pane ' + className}
      aria-labelledby={ariaLabel ? undefined : headingId}
      aria-label={ariaLabel}
    >
      <header className="pane__header">
        <div className="pane__heading">
          <h2 id={headingId}>{title}</h2>
          {subtitle ? <div className="pane__subtitle">{subtitle}</div> : null}
        </div>
        {toolbar ? <div className="pane__toolbar">{toolbar}</div> : null}
      </header>
      {tabs && tabs.length > 0 ? (
        <div className="pane__tabs" role="tablist" aria-label={title + ' views'}>
          {tabs.map((tab) => {
            const selected = tab.id === activeTab;
            return (
              <button
                key={tab.id}
                id={id + '-tab-' + tab.id}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={panelId}
                tabIndex={selected ? 0 : -1}
                onClick={() => onTabChange?.(tab.id)}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
      ) : null}
      <div
        id={panelId}
        className="pane__body"
        role={tabs && tabs.length > 0 ? 'tabpanel' : undefined}
        aria-labelledby={
          tabs && activeTab ? id + '-tab-' + activeTab : undefined
        }
        style={{ overflow }}
      >
        {children}
      </div>
    </section>
  );
}
~~~

- [ ] **Step 4: Implement the generic real-table primitive**

Create frontend/src/components/workspace/DataTable.tsx:

~~~tsx
import type { KeyboardEvent, ReactNode } from 'react';

export interface DataColumn<Row> {
  id: string;
  header: ReactNode;
  cell(row: Row): ReactNode;
  align?: 'left' | 'right';
  mobilePriority?: 'essential' | 'secondary';
}

export interface DataTableProps<Row> {
  ariaLabel: string;
  rows: readonly Row[];
  columns: readonly DataColumn<Row>[];
  rowKey(row: Row): string;
  emptyMessage: string;
  selectedKey?: string | null;
  onSelect?(row: Row): void;
  rowLabel?(row: Row): string;
  expandedKey?: string | null;
  onToggleExpanded?(row: Row): void;
  renderExpanded?(row: Row): ReactNode;
}

export function DataTable<Row>({
  ariaLabel,
  rows,
  columns,
  rowKey,
  emptyMessage,
  selectedKey,
  onSelect,
  rowLabel,
  expandedKey,
  onToggleExpanded,
  renderExpanded,
}: DataTableProps<Row>) {
  const activate = (row: Row) => {
    onSelect?.(row);
    onToggleExpanded?.(row);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTableRowElement>, row: Row) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      activate(row);
    }
  };
  const interactive = Boolean(onSelect || onToggleExpanded);

  return (
    <div className="data-table-wrap">
      <table className="data-table" aria-label={ariaLabel}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.id}
                scope="col"
                className={column.align === 'right' ? 'is-numeric' : undefined}
                data-mobile-priority={column.mobilePriority ?? 'essential'}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr className="data-table__empty">
              <td colSpan={columns.length}>{emptyMessage}</td>
            </tr>
          ) : rows.map((row) => {
            const key = rowKey(row);
            const selected = selectedKey === key;
            const expanded = expandedKey === key;
            return [
              <tr
                key={key}
                className={selected ? 'is-selected' : undefined}
                tabIndex={interactive ? 0 : undefined}
                aria-label={rowLabel?.(row)}
                aria-selected={onSelect ? selected : undefined}
                aria-expanded={onToggleExpanded ? expanded : undefined}
                onClick={interactive ? () => activate(row) : undefined}
                onKeyDown={interactive ? (event) => onKeyDown(event, row) : undefined}
              >
                {columns.map((column) => (
                  <td
                    key={column.id}
                    className={column.align === 'right' ? 'is-numeric' : undefined}
                    data-mobile-priority={column.mobilePriority ?? 'essential'}
                  >
                    {column.cell(row)}
                  </td>
                ))}
              </tr>,
              expanded && renderExpanded ? (
                <tr className="data-table__expanded" key={key + '-expanded'}>
                  <td colSpan={columns.length}>{renderExpanded(row)}</td>
                </tr>
              ) : null,
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}
~~~

- [ ] **Step 5: Run semantic tests and commit**

Run:

~~~bash
pnpm --dir frontend test -- src/components/workspace/StatusMessage.test.tsx src/components/workspace/Pane.test.tsx src/components/workspace/DataTable.test.tsx
~~~

Expected: all three files pass.

Commit:

~~~bash
git add frontend/src/components/workspace/Pane.tsx frontend/src/components/workspace/Pane.test.tsx frontend/src/components/workspace/DataTable.tsx frontend/src/components/workspace/DataTable.test.tsx frontend/src/components/workspace/StatusMessage.tsx frontend/src/components/workspace/StatusMessage.test.tsx
git commit -m "feat: add terminal pane and table primitives"
~~~

---

### Task 5: Linked Detail, Actions, and Resizable Workspace

**Files:**
- Create: frontend/src/hooks/useLinkedSelection.ts
- Create: frontend/src/hooks/useLinkedSelection.test.tsx
- Create: frontend/src/components/workspace/MasterDetail.tsx
- Create: frontend/src/components/workspace/MasterDetail.test.tsx
- Create: frontend/src/components/workspace/ActionControl.tsx
- Create: frontend/src/components/workspace/ActionControl.test.tsx
- Create: frontend/src/components/workspace/ResizableWorkspace.tsx
- Create: frontend/src/components/workspace/ResizableWorkspace.test.tsx

**Interfaces:**
- Consumes: ActionState and OperatorAction from Task 2.
- Produces: LinkedSelection<T>, useLinkedSelection(), MasterDetail, ActionControl, ColumnWidths, fitWidths(), and ResizableWorkspace.

- [ ] **Step 1: Write failing linked-selection tests**

Create frontend/src/hooks/useLinkedSelection.test.tsx:

~~~tsx
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useLinkedSelection } from './useLinkedSelection';

interface Item { symbol: string }

describe('useLinkedSelection', () => {
  it('selects the first row, preserves a surviving key, falls back, and clears', () => {
    const { result, rerender } = renderHook(
      ({ items }: { items: Item[] }) =>
        useLinkedSelection(items, (item) => item.symbol),
      { initialProps: { items: [{ symbol: 'AMD' }, { symbol: 'WBD' }] } },
    );
    expect(result.current.selectedKey).toBe('AMD');

    act(() => result.current.select({ symbol: 'WBD' }));
    expect(result.current.selectedKey).toBe('WBD');
    expect(result.current.detailOpen).toBe(true);

    rerender({ items: [{ symbol: 'WBD' }, { symbol: 'NVDA' }] });
    expect(result.current.selectedKey).toBe('WBD');

    rerender({ items: [{ symbol: 'NVDA' }] });
    expect(result.current.selectedKey).toBe('NVDA');

    rerender({ items: [] });
    expect(result.current.selectedKey).toBeNull();
    expect(result.current.selectedItem).toBeNull();
  });
});
~~~

Run:

~~~bash
pnpm --dir frontend test -- src/hooks/useLinkedSelection.test.tsx
~~~

Expected: FAIL because the hook does not exist.

- [ ] **Step 2: Implement stable linked selection**

Create frontend/src/hooks/useLinkedSelection.ts:

~~~ts
import { useEffect, useMemo, useState } from 'react';

export interface LinkedSelection<T> {
  selectedKey: string | null;
  selectedItem: T | null;
  detailOpen: boolean;
  select(item: T): void;
  closeDetail(): void;
}

export function useLinkedSelection<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
): LinkedSelection<T> {
  const [selectedKey, setSelectedKey] = useState<string | null>(() =>
    items[0] ? keyOf(items[0]) : null,
  );
  const [detailOpen, setDetailOpen] = useState(false);

  useEffect(() => {
    const surviving = selectedKey !== null && items.some((item) => keyOf(item) === selectedKey);
    if (!surviving) {
      setSelectedKey(items[0] ? keyOf(items[0]) : null);
      if (items.length === 0) setDetailOpen(false);
    }
  }, [items, keyOf, selectedKey]);

  const selectedItem = useMemo(
    () => items.find((item) => keyOf(item) === selectedKey) ?? null,
    [items, keyOf, selectedKey],
  );

  return {
    selectedKey,
    selectedItem,
    detailOpen,
    select(item) {
      setSelectedKey(keyOf(item));
      setDetailOpen(true);
    },
    closeDetail() {
      setDetailOpen(false);
    },
  };
}
~~~

Use module-level key functions in route components so keyOf remains referentially stable and does not retrigger the effect on each render.

- [ ] **Step 3: Write failing MasterDetail and ActionControl tests**

Create frontend/src/components/workspace/MasterDetail.test.tsx:

~~~tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MasterDetail } from './MasterDetail';

describe('MasterDetail', () => {
  it('labels the mobile detail screen and closes it', async () => {
    const onClose = vi.fn();
    render(
      <MasterDetail
        master={<div>Candidate rows</div>}
        detail={<div>AMD decision</div>}
        detailOpen
        detailLabel="AMD candidate detail"
        onDetailClose={onClose}
      />,
    );
    expect(screen.getByRole('group', { name: 'AMD candidate detail' })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Back to candidates' }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
~~~

Create frontend/src/components/workspace/ActionControl.test.tsx:

~~~tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ActionControl } from './ActionControl';

describe('ActionControl', () => {
  it('requires explicit confirmation before halting', async () => {
    const onInvoke = vi.fn().mockResolvedValue(undefined);
    render(
      <ActionControl
        action="halt"
        label="Halt trading"
        state={{ phase: 'idle' }}
        tone="danger"
        confirmation={{
          title: 'Halt trading?',
          body: 'New entries will remain blocked until trading is resumed.',
          confirmLabel: 'Halt trading',
        }}
        onInvoke={onInvoke}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Halt trading' }));
    expect(screen.getByRole('dialog', { name: 'Halt trading?' })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onInvoke).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Halt trading' }));
    await userEvent.click(screen.getByRole('button', { name: 'Confirm halt trading' }));
    expect(onInvoke).toHaveBeenCalledWith('halt');
  });

  it('disables repeat submission and announces an execution failure', () => {
    render(
      <ActionControl
        action="executionCheck"
        label="Check execution now"
        state={{
          phase: 'error',
          message: 'Execution check failed. Broker did not respond. No order was submitted.',
          completedAt: 1,
        }}
        onInvoke={vi.fn()}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('No order was submitted.');
  });

  it('shows a pending label and disables the control', () => {
    render(
      <ActionControl
        action="analysis"
        label="Run analysis"
        state={{ phase: 'pending', startedAt: 1 }}
        onInvoke={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Run analysis in progress' })).toBeDisabled();
  });

  it('announces a successful action without implying an order result', () => {
    render(
      <ActionControl
        action="analysis"
        label="Run analysis"
        state={{ phase: 'success', message: 'Analysis started.', completedAt: 1 }}
        onInvoke={vi.fn()}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Analysis started.');
  });
});
~~~

- [ ] **Step 4: Implement MasterDetail and ActionControl**

Create frontend/src/components/workspace/MasterDetail.tsx:

~~~tsx
import type { ReactNode } from 'react';

export interface MasterDetailProps {
  master: ReactNode;
  detail: ReactNode;
  detailOpen: boolean;
  detailLabel: string;
  onDetailClose(): void;
}

export function MasterDetail({
  master,
  detail,
  detailOpen,
  detailLabel,
  onDetailClose,
}: MasterDetailProps) {
  return (
    <div className="master-detail" data-detail-open={detailOpen}>
      <div className="master-detail__master">{master}</div>
      <div
        className="master-detail__detail"
        role="group"
        aria-label={detailLabel}
        aria-hidden={!detailOpen ? undefined : false}
      >
        <button
          className="master-detail__back"
          type="button"
          onClick={onDetailClose}
        >
          Back to candidates
        </button>
        {detail}
      </div>
    </div>
  );
}
~~~

Create frontend/src/components/workspace/ActionControl.tsx:

~~~tsx
import { useEffect, useRef, useState } from 'react';
import type { ActionState, OperatorAction } from '../../app/operatorState';

export interface ActionControlProps {
  action: OperatorAction;
  label: string;
  state: ActionState;
  tone?: 'routine' | 'danger';
  confirmation?: {
    title: string;
    body: string;
    confirmLabel: string;
  };
  disabled?: boolean;
  onInvoke(action: OperatorAction): Promise<void>;
}

export function ActionControl({
  action,
  label,
  state,
  tone = 'routine',
  confirmation,
  disabled = false,
  onInvoke,
}: ActionControlProps) {
  const [confirming, setConfirming] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const pending = state.phase === 'pending';

  useEffect(() => {
    if (confirming) cancelRef.current?.focus();
  }, [confirming]);

  const close = () => {
    setConfirming(false);
    window.setTimeout(() => triggerRef.current?.focus(), 0);
  };

  const invoke = async () => {
    setConfirming(false);
    await onInvoke(action);
  };

  return (
    <div className={'action-control action-control--' + tone}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled || pending}
        aria-label={pending ? label + ' in progress' : label}
        onClick={() => confirmation ? setConfirming(true) : void invoke()}
      >
        {pending ? label + '…' : label}
      </button>
      {confirming && confirmation ? (
        <div
          className="confirmation"
          role="dialog"
          aria-modal="true"
          aria-labelledby={action + '-confirmation-title'}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              close();
            }
          }}
        >
          <div className="confirmation__surface">
            <h2 id={action + '-confirmation-title'}>{confirmation.title}</h2>
            <p>{confirmation.body}</p>
            <div className="confirmation__actions">
              <button ref={cancelRef} type="button" onClick={close}>Cancel</button>
              <button
                type="button"
                className="is-danger"
                aria-label={'Confirm ' + confirmation.confirmLabel.toLowerCase()}
                onClick={() => void invoke()}
              >
                {confirmation.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {state.phase === 'success' ? (
        <div className="action-control__result is-success" role="status" aria-live="polite">
          {state.message}
        </div>
      ) : null}
      {state.phase === 'error' ? (
        <div className="action-control__result is-error" role="alert" aria-live="assertive">
          {state.message}
        </div>
      ) : null}
    </div>
  );
}
~~~

- [ ] **Step 5: Write failing resizable-workspace tests**

Create frontend/src/components/workspace/ResizableWorkspace.test.tsx:

~~~tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { setViewport } from '../../test/viewport';
import { ResizableWorkspace, fitWidths } from './ResizableWorkspace';

const props = {
  storageKey: 'offhours.monitor.columns.v1',
  defaults: { left: 260, right: 360 },
  constraints: {
    left: [220, 360] as const,
    centerMin: 480,
    right: [300, 480] as const,
  },
  left: <div>Account</div>,
  center: <div>Candidates</div>,
  right: <div>Detail</div>,
  bottom: <div>Activity</div>,
};

describe('ResizableWorkspace', () => {
  it('fits the 1024px boundary without shrinking center below 480px', () => {
    expect(fitWidths(1024, props.defaults, props.constraints)).toEqual({
      left: 242,
      right: 300,
    });
  });

  it('restores valid versioned storage and ignores malformed storage', () => {
    setViewport(1440, 900);
    localStorage.setItem(
      props.storageKey,
      JSON.stringify({ version: 1, left: 300, right: 420 }),
    );
    const { unmount } = render(<ResizableWorkspace {...props} />);
    expect(screen.getByRole('separator', { name: 'Resize account pane' }))
      .toHaveAttribute('aria-valuenow', '300');
    unmount();

    localStorage.setItem(props.storageKey, '{"version":1,"left":"bad"}');
    render(<ResizableWorkspace {...props} />);
    expect(screen.getByRole('separator', { name: 'Resize account pane' }))
      .toHaveAttribute('aria-valuenow', '260');
  });

  it('supports arrow resizing, persistence, and double-click reset', () => {
    setViewport(1440, 900);
    render(<ResizableWorkspace {...props} />);
    const separator = screen.getByRole('separator', { name: 'Resize account pane' });
    fireEvent.keyDown(separator, { key: 'ArrowRight' });
    expect(separator).toHaveAttribute('aria-valuenow', '270');
    expect(JSON.parse(localStorage.getItem(props.storageKey) ?? '{}')).toMatchObject({
      version: 1,
      left: 270,
    });
    fireEvent.doubleClick(separator);
    expect(separator).toHaveAttribute('aria-valuenow', '260');
    expect(localStorage.getItem(props.storageKey)).toBeNull();
  });

  it('removes separators below the 1016px three-column threshold', () => {
    setViewport(900, 700);
    render(<ResizableWorkspace {...props} />);
    expect(screen.queryByRole('separator')).not.toBeInTheDocument();
    expect(screen.getByTestId('resizable-workspace')).toHaveAttribute(
      'data-layout',
      'compact',
    );
  });
});
~~~

Run:

~~~bash
pnpm --dir frontend test -- src/components/workspace/ResizableWorkspace.test.tsx
~~~

Expected: FAIL because ResizableWorkspace.tsx does not exist.

- [ ] **Step 6: Implement constrained, persisted resizing**

Create frontend/src/components/workspace/ResizableWorkspace.tsx:

~~~tsx
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';

export interface ColumnWidths {
  left: number;
  right: number;
}

export interface WorkspaceConstraints {
  left: readonly [220, 360];
  centerMin: 480;
  right: readonly [300, 480];
}

export interface ResizableWorkspaceProps {
  storageKey: string;
  defaults: ColumnWidths;
  constraints: WorkspaceConstraints;
  left: ReactNode;
  center: ReactNode;
  right: ReactNode;
  bottom?: ReactNode;
  detailOpen?: boolean;
  detailLabel?: string;
  onDetailClose?(): void;
}

const dividerWidth = 1;
const wideWorkspaceMin = 1016;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function fitWidths(
  containerWidth: number,
  desired: ColumnWidths,
  constraints: WorkspaceConstraints,
): ColumnWidths {
  let left = clamp(desired.left, constraints.left[0], constraints.left[1]);
  let right = clamp(desired.right, constraints.right[0], constraints.right[1]);
  const sideBudget = containerWidth - constraints.centerMin - dividerWidth * 2;
  let excess = Math.max(0, left + right - sideBudget);
  const rightReduction = Math.min(excess, right - constraints.right[0]);
  right -= rightReduction;
  excess -= rightReduction;
  left -= Math.min(excess, left - constraints.left[0]);
  return { left, right };
}

function readStored(key: string, fallback: ColumnWidths): ColumnWidths {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? 'null') as {
      version?: unknown;
      left?: unknown;
      right?: unknown;
    } | null;
    if (
      parsed?.version === 1 &&
      typeof parsed.left === 'number' &&
      Number.isFinite(parsed.left) &&
      typeof parsed.right === 'number' &&
      Number.isFinite(parsed.right)
    ) {
      return { left: parsed.left, right: parsed.right };
    }
  } catch {
    return fallback;
  }
  return fallback;
}

export function ResizableWorkspace({
  storageKey,
  defaults,
  constraints,
  left,
  center,
  right,
  bottom,
  detailOpen = false,
  detailLabel = 'Detail',
  onDetailClose = () => undefined,
}: ResizableWorkspaceProps) {
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [desired, setDesired] = useState(() => readStored(storageKey, defaults));
  const drag = useRef<{
    side: 'left' | 'right';
    startX: number;
    widths: ColumnWidths;
  } | null>(null);

  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const wide = viewportWidth >= wideWorkspaceMin;
  const effective = useMemo(
    () => fitWidths(viewportWidth, desired, constraints),
    [constraints, desired, viewportWidth],
  );

  const persist = (next: ColumnWidths) => {
    setDesired(next);
    localStorage.setItem(storageKey, JSON.stringify({ version: 1, ...next }));
  };

  const resize = (side: 'left' | 'right', requested: number) => {
    const sideBudget = viewportWidth - constraints.centerMin - dividerWidth * 2;
    if (side === 'left') {
      const maximum = Math.min(constraints.left[1], sideBudget - effective.right);
      persist({ ...effective, left: clamp(requested, constraints.left[0], maximum) });
    } else {
      const maximum = Math.min(constraints.right[1], sideBudget - effective.left);
      persist({ ...effective, right: clamp(requested, constraints.right[0], maximum) });
    }
  };

  const beginDrag = (
    side: 'left' | 'right',
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { side, startX: event.clientX, widths: effective };
  };

  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const delta = event.clientX - drag.current.startX;
    const requested = drag.current.side === 'left'
      ? drag.current.widths.left + delta
      : drag.current.widths.right - delta;
    resize(drag.current.side, requested);
  };

  const reset = () => {
    setDesired(defaults);
    localStorage.removeItem(storageKey);
  };

  if (!wide) {
    return (
      <div
        className="resizable-workspace resizable-workspace--compact"
        data-layout="compact"
        data-detail-open={detailOpen}
        data-testid="resizable-workspace"
      >
        <div className="resizable-workspace__left">{left}</div>
        <div className="resizable-workspace__center">{center}</div>
        <div
          className="resizable-workspace__right"
          role="group"
          aria-label={detailLabel}
        >
          <button
            className="resizable-workspace__back"
            type="button"
            onClick={onDetailClose}
          >
            Back to candidates
          </button>
          {right}
        </div>
        {bottom ? <div className="resizable-workspace__bottom">{bottom}</div> : null}
      </div>
    );
  }

  const style = {
    '--left-width': String(effective.left) + 'px',
    '--right-width': String(effective.right) + 'px',
  } as CSSProperties;

  const separator = (side: 'left' | 'right') => {
    const current = effective[side];
    const bounds = constraints[side];
    const direction = side === 'left' ? 1 : -1;
    const sideBudget = viewportWidth - constraints.centerMin - dividerWidth * 2;
    const maximum = Math.min(
      bounds[1],
      sideBudget - (side === 'left' ? effective.right : effective.left),
    );
    return (
      <div
        className={'resizable-workspace__separator is-' + side}
        role="separator"
        aria-label={side === 'left' ? 'Resize account pane' : 'Resize candidate detail pane'}
        aria-orientation="vertical"
        aria-valuemin={bounds[0]}
        aria-valuemax={maximum}
        aria-valuenow={current}
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') resize(side, current - 10 * direction);
          if (event.key === 'ArrowRight') resize(side, current + 10 * direction);
          if (event.key === 'Home') resize(side, bounds[0]);
          if (event.key === 'End') resize(side, maximum);
        }}
        onPointerDown={(event) => beginDrag(side, event)}
        onPointerMove={moveDrag}
        onPointerUp={() => { drag.current = null; }}
        onPointerCancel={() => { drag.current = null; }}
        onDoubleClick={reset}
      />
    );
  };

  return (
    <div
      className="resizable-workspace"
      data-layout="wide"
      data-testid="resizable-workspace"
      style={style}
    >
      <div className="resizable-workspace__left">{left}</div>
      {separator('left')}
      <div className="resizable-workspace__center">{center}</div>
      {separator('right')}
      <div className="resizable-workspace__right">{right}</div>
      {bottom ? <div className="resizable-workspace__bottom">{bottom}</div> : null}
    </div>
  );
}
~~~

- [ ] **Step 7: Run all interaction primitive checks**

Run:

~~~bash
pnpm --dir frontend test -- src/hooks/useLinkedSelection.test.tsx src/components/workspace/MasterDetail.test.tsx src/components/workspace/ActionControl.test.tsx src/components/workspace/ResizableWorkspace.test.tsx
pnpm --dir frontend build
~~~

Expected: all four focused test files and the build pass.

- [ ] **Step 8: Commit interactions**

~~~bash
git add frontend/src/hooks frontend/src/components/workspace
git commit -m "feat: add linked and resizable terminal interactions"
~~~

---

### Task 6: Monitor Route

**Files:**
- Create: frontend/src/views/MonitorView.tsx
- Create: frontend/src/views/MonitorView.test.tsx

**Interfaces:**
- Consumes: StatusResponse, PositionsResponse, CandidateFile, VerdictFile, Thesis, AuditEvent[], Config, buildCandidateDecisionRows(), presentAuditEvent(), Pane, DataTable, MasterDetail, ResizableWorkspace, StatusMessage, and useLinkedSelection().
- Produces: MonitorView(props), the account/automation summaries, candidate decision table, linked Summary/Evidence/Rules detail, and activity blotter.

- [ ] **Step 1: Write failing Monitor behavior tests**

Create frontend/src/views/MonitorView.test.tsx:

~~~tsx
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  auditFixture,
  candidatesFixture,
  configFixture,
  offhoursPlanFixture,
  positionsFixture,
  statusFixture,
  verdictsFixture,
} from '../test/fixtures';
import { MonitorView } from './MonitorView';

const props = {
  status: statusFixture,
  positions: positionsFixture,
  candidates: candidatesFixture,
  verdicts: verdictsFixture,
  activePlan: offhoursPlanFixture,
  audit: auditFixture,
  config: configFixture,
};

describe('MonitorView', () => {
  it('makes the candidate table dominant and links a selected row to detail', async () => {
    render(<MonitorView {...props} />);
    expect(screen.getByRole('table', { name: 'Candidate monitor' })).toBeVisible();
    expect(screen.getByRole('region', { name: 'Candidate detail' })).toHaveTextContent(
      'AMD',
    );

    await userEvent.click(screen.getByRole('row', { name: 'Inspect WBD' }));

    expect(screen.getByRole('region', { name: 'Candidate detail' })).toHaveTextContent(
      'No entry for WBD',
    );
    expect(screen.getByRole('region', { name: 'Candidate detail' })).toHaveTextContent(
      'Not recorded',
    );
  });

  it('states unavailable account data without estimating it', () => {
    render(<MonitorView {...props} />);
    expect(screen.getByText('Daily deployment used')).toBeVisible();
    expect(screen.getByText('Not available from current API')).toBeVisible();
  });

  it('states the closed-market execution consequence', () => {
    render(
      <MonitorView
        {...props}
        status={{ ...statusFixture, session: 'closed' }}
      />,
    );
    expect(screen.getByText(
      'The market is closed. An execution check will be recorded without submitting an order.',
    )).toBeVisible();
  });

  it('distinguishes active, expired, and missing trading plans', () => {
    const { rerender } = render(<MonitorView {...props} />);
    expect(screen.getByText('1 selected, 1 not selected.')).toBeVisible();
    rerender(
      <MonitorView
        {...props}
        activePlan={{ ...offhoursPlanFixture, expiresAt: '2020-01-01T00:00:00.000Z' }}
      />,
    );
    expect(screen.getByText(/The latest trading plan expired at/)).toBeVisible();
    rerender(<MonitorView {...props} activePlan={null} />);
    expect(screen.getByText('No trading plan is available.')).toBeVisible();
  });

  it('states when no candidate can be inspected', () => {
    render(
      <MonitorView
        {...props}
        candidates={null}
        verdicts={null}
        activePlan={null}
      />,
    );
    expect(screen.getByText('There is no candidate to inspect.')).toBeVisible();
  });

  it('uses no more than five default candidate columns', () => {
    render(<MonitorView {...props} />);
    expect(
      within(screen.getByRole('table', { name: 'Candidate monitor' }))
        .getAllByRole('columnheader'),
    ).toHaveLength(5);
  });
});
~~~

Run:

~~~bash
pnpm --dir frontend test -- src/views/MonitorView.test.tsx
~~~

Expected: FAIL because MonitorView.tsx does not exist.

- [ ] **Step 2: Implement account and automation summaries**

At the top of frontend/src/views/MonitorView.tsx define these exact helpers:

~~~tsx
import { useMemo, useState } from 'react';
import { ANALYSTS } from '../types';
import type {
  AuditEvent,
  CandidateFile,
  Config,
  Direction,
  PositionsResponse,
  StatusResponse,
  Thesis,
  VerdictFile,
} from '../types';
import { DataTable, type DataColumn } from '../components/workspace/DataTable';
import { Pane } from '../components/workspace/Pane';
import { ResizableWorkspace } from '../components/workspace/ResizableWorkspace';
import { StatusMessage } from '../components/workspace/StatusMessage';
import { useLinkedSelection } from '../hooks/useLinkedSelection';
import {
  buildCandidateDecisionRows,
  type CandidateDecisionRow,
} from '../presentation/candidates';
import { presentAuditEvent, type PresentedAuditEvent } from '../presentation/audit';
import {
  formatEtTimestamp,
  formatPercent,
  formatUsd,
  sentenceCase,
} from '../presentation/format';

export interface MonitorViewProps {
  status: StatusResponse | null;
  positions: PositionsResponse;
  candidates: CandidateFile | null;
  verdicts: VerdictFile | null;
  activePlan: Thesis | null;
  audit: readonly AuditEvent[];
  config: Config | null;
}

function keyOfCandidate(row: CandidateDecisionRow): string {
  return row.symbol;
}

function directionText(direction: Direction): string {
  if (direction === 'long') return 'Long';
  if (direction === 'short') return 'Short';
  return 'No position';
}

function accountRows(
  status: StatusResponse | null,
  positions: PositionsResponse,
  config: Config | null,
) {
  const exposure = positions.positions.reduce(
    (total, position) => total + Math.abs(position.marketValue),
    0,
  );
  const pnl = positions.positions.reduce(
    (total, position) => total + position.unrealizedPl,
    0,
  );
  const brokerDataAvailable = !positions.error;
  return [
    ['Account value', formatUsd(status?.equity), undefined],
    ['Open exposure', brokerDataAvailable ? formatUsd(exposure) : 'Not available', undefined],
    ['Open positions', brokerDataAvailable ? String(positions.positions.length) : 'Not available', undefined],
    [
      'Open gain/loss',
      brokerDataAvailable ? (pnl >= 0 ? '+' : '') + formatUsd(pnl) : 'Not available',
      brokerDataAvailable
        ? pnl >= 0 ? 'semantic-text--positive' : 'semantic-text--negative'
        : undefined,
    ],
    ['Daily deployment used', 'Not available from current API', undefined],
    ['Daily deployment limit', formatPercent(config?.max_daily_deploy_pct), undefined],
    [
      'Risk halt',
      status?.halt?.halted
        ? 'Halted — ' + (status.halt.reason || 'Reason not recorded')
        : 'Clear',
      status?.halt?.halted ? 'semantic-text--negative' : 'semantic-text--positive',
    ],
  ] as const;
}

function latestEvent(events: readonly AuditEvent[], kinds: readonly string[]): AuditEvent | null {
  return [...events]
    .filter((event) => kinds.includes(event.kind))
    .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))[0] ?? null;
}

function planState(plan: Thesis | null): string {
  if (!plan) return 'No trading plan is available.';
  const expiry = Date.parse(plan.expiresAt);
  if (Number.isFinite(expiry) && expiry <= Date.now()) {
    return 'The latest trading plan expired at ' + formatEtTimestamp(plan.expiresAt) + '.';
  }
  return String(plan.entries.length) + ' selected, ' + String(plan.skipped.length) + ' not selected.';
}
~~~

- [ ] **Step 3: Implement the complete Monitor component**

Continue frontend/src/views/MonitorView.tsx with:

~~~tsx
function AccountPane(props: Pick<MonitorViewProps, 'status' | 'positions' | 'config'>) {
  return (
    <Pane id="account-state" title="Account">
      <dl className="definition-rows">
        {accountRows(props.status, props.positions, props.config).map(([label, value, tone]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd className={tone}>{value}</dd>
          </div>
        ))}
      </dl>
      {props.positions.error ? (
        <StatusMessage tone="error">
          Position data is unavailable. {props.positions.error} No position state was confirmed.
        </StatusMessage>
      ) : null}
    </Pane>
  );
}

function AutomationPane(props: Pick<MonitorViewProps, 'status' | 'activePlan' | 'audit' | 'config'>) {
  const analysis = latestEvent(props.audit, ['thesis', 'candidates']);
  const execution = latestEvent(props.audit, ['tick']);
  const interval = props.config?.executor_interval_min;
  const next = execution && interval
    ? new Date(Date.parse(execution.ts) + interval * 60_000).toISOString()
    : null;
  const analysisState = analysis ? presentAuditEvent(analysis) : null;
  const executionState = execution ? presentAuditEvent(execution) : null;
  return (
    <Pane id="automation-state" title="Automation">
      <dl className="definition-rows">
        <div>
          <dt>Latest analysis</dt>
          <dd>
            {analysisState
              ? analysisState.description + ' ' + analysisState.timestamp
              : 'Not recorded'}
          </dd>
        </div>
        <div>
          <dt>Current trading plan</dt>
          <dd>{planState(props.activePlan)}</dd>
        </div>
        <div>
          <dt>Last execution check</dt>
          <dd>
            {executionState
              ? executionState.description + ' ' + executionState.timestamp
              : 'Not recorded'}
          </dd>
        </div>
        <div>
          <dt>Next execution check</dt>
          <dd>{next ? formatEtTimestamp(next) : 'Not recorded'}</dd>
        </div>
      </dl>
      {props.status?.session === 'closed' ? (
        <StatusMessage tone="warning">
          The market is closed. An execution check will be recorded without submitting an order.
        </StatusMessage>
      ) : null}
    </Pane>
  );
}

function CandidateDetail({ row, plan }: { row: CandidateDecisionRow | null; plan: Thesis | null }) {
  const [tab, setTab] = useState('summary');
  if (!row) {
    return (
      <Pane id="candidate-detail" title="Candidate detail">
        <StatusMessage tone="empty">There is no candidate to inspect.</StatusMessage>
      </Pane>
    );
  }
  const explanation = row.entry
    ? row.outcomeText + '.'
    : 'No entry for ' + row.symbol + '. ' + (row.skipReason ?? 'A decision was not recorded.');
  const invalidations = row.entry?.invalidationConditions.length
    ? row.entry.invalidationConditions
    : [...new Set(row.verdicts.flatMap((item) => item.invalidation_conditions))];
  return (
    <Pane
      id="candidate-detail"
      title="Candidate detail"
      subtitle={row.symbol}
      tabs={[
        { id: 'summary', label: 'Summary' },
        { id: 'evidence', label: 'Evidence' },
        { id: 'rules', label: 'Rules' },
      ]}
      activeTab={tab}
      onTabChange={setTab}
    >
      {tab === 'summary' ? (
        <div className="detail-stack">
          <p>{explanation}</p>
          <dl className="definition-rows">
            <div><dt>Panel position</dt><dd>{directionText(row.panelPosition)}</dd></div>
            <div>
              <dt>Agreement</dt>
              <dd>
                {String(row.agreeing)} of {row.requiredAgreeing ?? 'Not recorded'} required
              </dd>
            </div>
            <div><dt>Confidence</dt><dd>{row.confidenceText}</dd></div>
            <div>
              <dt>Required confidence</dt>
              <dd>{formatPercent(row.requiredConfidence)}</dd>
            </div>
          </dl>
          <DataTable
            ariaLabel={row.symbol + ' analyst views'}
            rows={ANALYSTS.map((analyst) => ({
              analyst,
              view: row.verdicts.find((item) => item.analyst === analyst) ?? null,
            }))}
            columns={[
              { id: 'analyst', header: 'Analyst', cell: (item) => sentenceCase(item.analyst) },
              {
                id: 'position',
                header: 'Position',
                cell: (item) => item.view ? directionText(item.view.direction) : 'Not recorded',
              },
              {
                id: 'confidence',
                header: 'Confidence',
                cell: (item) => item.view ? formatPercent(item.view.conviction) : 'Not recorded',
                align: 'right',
              },
            ]}
            rowKey={(item) => item.analyst}
            emptyMessage="No analyst views were recorded."
          />
        </div>
      ) : null}
      {tab === 'evidence' ? (
        <div className="detail-stack">
          {row.verdicts.length === 0 ? (
            <StatusMessage tone="empty">No analyst evidence was recorded.</StatusMessage>
          ) : row.verdicts.map((verdict) => (
            <section className="evidence-group" key={verdict.analyst}>
              <h3>{sentenceCase(verdict.analyst)}</h3>
              <ul>{verdict.evidence.map((item) => <li key={item}>{item}</li>)}</ul>
            </section>
          ))}
        </div>
      ) : null}
      {tab === 'rules' ? (
        <div className="detail-stack">
          <section>
            <h3>Invalidation conditions</h3>
            {invalidations.length ? (
              <ul>{invalidations.map((item) => <li key={item}>{item}</li>)}</ul>
            ) : (
              <p>Not recorded</p>
            )}
          </section>
          <section>
            <h3>Sizing attribution</h3>
            {row.entry?.sizing ? (
              <div className="detail-stack">
                <dl className="definition-rows">
                  <div><dt>Base notional</dt><dd>{formatUsd(row.entry.sizing.baseNotional)}</dd></div>
                  <div><dt>Target notional</dt><dd>{formatUsd(row.entry.targetNotionalUsd)}</dd></div>
                  <div><dt>Volatility scalar</dt><dd>{formatPercent(row.entry.sizing.volScalar)}</dd></div>
                  <div><dt>Combined scalar</dt><dd>{formatPercent(row.entry.sizing.product)}</dd></div>
                </dl>
                <DataTable
                  ariaLabel={row.symbol + ' sizing attribution'}
                  rows={Object.keys(row.entry.sizing.scalars).map((signal) => ({
                    signal,
                    applied: row.entry!.sizing!.scalars[signal],
                    without: row.entry!.sizing!.leaveOneOut[signal],
                  }))}
                  columns={[
                    { id: 'signal', header: 'Signal', cell: (item) => sentenceCase(item.signal) },
                    {
                      id: 'applied',
                      header: 'Applied scalar',
                      cell: (item) => formatPercent(item.applied),
                      align: 'right',
                    },
                    {
                      id: 'without',
                      header: 'Without signal',
                      cell: (item) => formatPercent(item.without),
                      align: 'right',
                    },
                  ]}
                  rowKey={(item) => item.signal}
                  emptyMessage="No sizing signals were recorded."
                />
              </div>
            ) : <p>Not recorded</p>}
          </section>
          <section>
            <h3>Market regime</h3>
            {plan?.regime ? (
              <dl className="definition-rows">
                <div><dt>State</dt><dd>{plan.regime.state}</dd></div>
                <div><dt>Long scalar</dt><dd>{formatPercent(plan.regime.longScalar)}</dd></div>
                <div><dt>Short scalar</dt><dd>{formatPercent(plan.regime.shortScalar)}</dd></div>
                <div><dt>Volatility scalar</dt><dd>{formatPercent(plan.regime.volScalar)}</dd></div>
                <div><dt>Threshold adjustment</dt><dd>{formatPercent(plan.regime.thresholdBump)}</dd></div>
              </dl>
            ) : <p>Not recorded</p>}
          </section>
        </div>
      ) : null}
    </Pane>
  );
}

function ActivityBlotter({ audit }: { audit: readonly AuditEvent[] }) {
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const rows = useMemo(
    () => audit
      .map((event, index) => presentAuditEvent(event, index))
      .sort((a, b) => b.id.localeCompare(a.id))
      .slice(0, 20),
    [audit],
  );
  const columns: DataColumn<PresentedAuditEvent>[] = [
    { id: 'time', header: 'Time (ET)', cell: (row) => row.timestamp },
    { id: 'activity', header: 'Activity', cell: (row) => row.activity },
    { id: 'stage', header: 'Stage', cell: (row) => row.stage, mobilePriority: 'secondary' },
    { id: 'status', header: 'Status', cell: (row) => sentenceCase(row.status) },
    {
      id: 'description',
      header: 'What happened',
      cell: (row) => row.description,
      mobilePriority: 'secondary',
    },
  ];
  return (
    <Pane id="activity-blotter" title="Activity">
      <DataTable
        ariaLabel="Recent activity"
        rows={rows}
        columns={columns}
        rowKey={(row) => row.id}
        emptyMessage="No activity was recorded."
        expandedKey={expandedKey}
        onToggleExpanded={(row) => setExpandedKey(expandedKey === row.id ? null : row.id)}
        renderExpanded={(row) => (
          <div className="raw-detail">
            <p>{row.description}</p>
            <pre>{row.rawJson}</pre>
          </div>
        )}
      />
    </Pane>
  );
}

export function MonitorView(props: MonitorViewProps) {
  const rows = useMemo(
    () => buildCandidateDecisionRows({
      candidates: props.candidates,
      verdicts: props.verdicts,
      plan: props.activePlan,
      config: props.config,
    }),
    [props.activePlan, props.candidates, props.config, props.verdicts],
  );
  const selection = useLinkedSelection(rows, keyOfCandidate);
  const columns: DataColumn<CandidateDecisionRow>[] = [
    { id: 'symbol', header: 'Symbol', cell: (row) => row.symbol },
    {
      id: 'position',
      header: 'Panel position',
      cell: (row) => directionText(row.panelPosition),
    },
    {
      id: 'agreement',
      header: 'Agreement',
      cell: (row) => String(row.agreeing) + ' / ' + (row.requiredAgreeing ?? '—'),
      align: 'right',
      mobilePriority: 'secondary',
    },
    {
      id: 'confidence',
      header: (
        <abbr title="Recorded weighted confidence. Skipped-candidate confidence is not reconstructed.">
          Confidence
        </abbr>
      ),
      cell: (row) => row.confidenceText,
      align: 'right',
      mobilePriority: 'secondary',
    },
    { id: 'outcome', header: 'Outcome', cell: (row) => row.outcomeText },
  ];

  const master = (
    <Pane id="candidate-monitor" title="Candidate monitor">
      <DataTable
        ariaLabel="Candidate monitor"
        rows={rows}
        columns={columns}
        rowKey={keyOfCandidate}
        rowLabel={(row) => 'Inspect ' + row.symbol}
        selectedKey={selection.selectedKey}
        onSelect={selection.select}
        emptyMessage="No candidates were recorded."
      />
    </Pane>
  );
  const detail = <CandidateDetail row={selection.selectedItem} plan={props.activePlan} />;

  return (
    <main className="route route--monitor">
      <ResizableWorkspace
        storageKey="offhours.monitor.columns.v1"
        defaults={{ left: 260, right: 360 }}
        constraints={{
          left: [220, 360],
          centerMin: 480,
          right: [300, 480],
        }}
        left={(
          <div className="monitor-sidebar">
            <AccountPane status={props.status} positions={props.positions} config={props.config} />
            <AutomationPane
              status={props.status}
              activePlan={props.activePlan}
              audit={props.audit}
              config={props.config}
            />
          </div>
        )}
        center={master}
        right={detail}
        bottom={<ActivityBlotter audit={props.audit} />}
        detailOpen={selection.detailOpen}
        detailLabel="Candidate detail"
        onDetailClose={selection.closeDetail}
      />
    </main>
  );
}
~~~

ResizableWorkspace renders the candidate detail exactly once. At 1016 px and wider it occupies the right grid area; at 900–1015 px it sits beside the candidate table without handles; below 900 px the same node becomes the in-route detail screen.

- [ ] **Step 4: Run Monitor checks and commit**

Run:

~~~bash
pnpm --dir frontend test -- src/views/MonitorView.test.tsx
pnpm --dir frontend build
~~~

Expected: Monitor tests and build pass.

Commit:

~~~bash
git add frontend/src/views/MonitorView.tsx frontend/src/views/MonitorView.test.tsx
git commit -m "feat: build the operator monitor route"
~~~

---

### Task 7: Research Route

**Files:**
- Create: frontend/src/views/ResearchView.tsx
- Create: frontend/src/views/ResearchView.test.tsx

**Interfaces:**
- Consumes: candidate, analyst-view, off-hours plan, regular-session plan, and config data; shared Pane/DataTable/MasterDetail/useLinkedSelection primitives.
- Produces: ResearchView with synchronized symbol selection, candidate/filtered/plan tabs, five-analyst matrix, and recorded plan detail.

- [ ] **Step 1: Write failing Research tests**

Create frontend/src/views/ResearchView.test.tsx:

~~~tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  candidatesFixture,
  configFixture,
  offhoursPlanFixture,
  rthPlanFixture,
  verdictsFixture,
} from '../test/fixtures';
import { ResearchView } from './ResearchView';

const props = {
  candidates: candidatesFixture,
  verdicts: verdictsFixture,
  offhoursPlan: offhoursPlanFixture,
  rthPlan: rthPlanFixture,
  config: configFixture,
};

describe('ResearchView', () => {
  it('keeps one selected symbol across candidate and analyst information', async () => {
    render(<ResearchView {...props} />);
    await userEvent.click(screen.getByRole('row', { name: 'Inspect WBD research' }));
    expect(screen.getByRole('region', { name: 'Research detail' })).toHaveTextContent('WBD');
    expect(screen.getByRole('region', { name: 'Research detail' })).toHaveTextContent(
      '1 of 2 required analysts agreed.',
    );
    expect(screen.getByRole('table', { name: 'WBD analyst matrix' })).toBeVisible();
  });

  it('shows the exact filtered-out reason', async () => {
    render(<ResearchView {...props} />);
    await userEvent.click(screen.getByRole('tab', { name: 'Filtered out' }));
    expect(screen.getByText('Excluded by universe configuration.')).toBeVisible();
  });

  it('exposes off-hours and regular-session plans without calling them theses', () => {
    render(<ResearchView {...props} />);
    expect(screen.getByRole('tab', { name: 'Off-hours plan' })).toBeVisible();
    expect(screen.getByRole('tab', { name: 'Regular-session plan' })).toBeVisible();
    expect(screen.queryByText(/\bthesis\b/i)).not.toBeInTheDocument();
  });
});
~~~

Run:

~~~bash
pnpm --dir frontend test -- src/views/ResearchView.test.tsx
~~~

Expected: FAIL because ResearchView.tsx does not exist.

- [ ] **Step 2: Implement synchronized Research master-detail**

Create frontend/src/views/ResearchView.tsx:

~~~tsx
import { useMemo, useState } from 'react';
import { DataTable, type DataColumn } from '../components/workspace/DataTable';
import { MasterDetail } from '../components/workspace/MasterDetail';
import { Pane } from '../components/workspace/Pane';
import { StatusMessage } from '../components/workspace/StatusMessage';
import { useLinkedSelection } from '../hooks/useLinkedSelection';
import {
  formatEtTimestamp,
  formatPercent,
  formatUsd,
  sentenceCase,
} from '../presentation/format';
import {
  ANALYSTS,
  type CandidateFile,
  type Config,
  type Direction,
  type Thesis,
  type VerdictFile,
} from '../types';

export interface ResearchViewProps {
  candidates: CandidateFile | null;
  verdicts: VerdictFile | null;
  offhoursPlan: Thesis | null;
  rthPlan: Thesis | null;
  config: Config | null;
}

interface ResearchSymbol {
  symbol: string;
}

function symbolKey(item: ResearchSymbol): string {
  return item.symbol;
}

function direction(direction: Direction): string {
  return direction === 'long' ? 'Long' : direction === 'short' ? 'Short' : 'No position';
}

export function ResearchView({
  candidates,
  verdicts,
  offhoursPlan,
  rthPlan,
}: ResearchViewProps) {
  const [tab, setTab] = useState('candidates');
  const symbols = useMemo(() => {
    const values = new Set<string>();
    candidates?.candidates.forEach((item) => values.add(item.ticker));
    candidates?.rejected.forEach((item) => values.add(item.ticker));
    verdicts?.verdicts.forEach((item) => values.add(item.ticker));
    offhoursPlan?.entries.forEach((item) => values.add(item.ticker));
    offhoursPlan?.skipped.forEach((item) => values.add(item.ticker));
    rthPlan?.entries.forEach((item) => values.add(item.ticker));
    rthPlan?.skipped.forEach((item) => values.add(item.ticker));
    return [...values].sort().map((symbol) => ({ symbol }));
  }, [candidates, offhoursPlan, rthPlan, verdicts]);
  const selection = useLinkedSelection(symbols, symbolKey);
  const selected = selection.selectedItem?.symbol ?? null;

  const candidateRows = candidates?.candidates ?? [];
  const filteredRows = candidates?.rejected.map((item) => ({
    symbol: item.ticker,
    reason: item.reason,
  })) ?? [];
  const offhoursRows = offhoursPlan?.entries.map((item) => ({ symbol: item.ticker })) ?? [];
  const rthRows = rthPlan?.entries.map((item) => ({ symbol: item.ticker })) ?? [];
  const basicColumns: DataColumn<ResearchSymbol>[] = [
    { id: 'symbol', header: 'Symbol', cell: (row) => row.symbol },
  ];

  const selectSymbol = (row: ResearchSymbol) => {
    const item = symbols.find((candidate) => candidate.symbol === row.symbol);
    if (item) selection.select(item);
  };

  const list = (
    <Pane
      id="research-list"
      title="Research"
      tabs={[
        { id: 'candidates', label: 'Candidates' },
        { id: 'filtered', label: 'Filtered out' },
        { id: 'offhours', label: 'Off-hours plan' },
        { id: 'rth', label: 'Regular-session plan' },
      ]}
      activeTab={tab}
      onTabChange={setTab}
    >
      {tab === 'candidates' ? (
        <DataTable
          ariaLabel="Research candidates"
          rows={candidateRows}
          columns={[
            { id: 'symbol', header: 'Symbol', cell: (row) => row.ticker },
            {
              id: 'nominated',
              header: 'Nominated by',
              cell: (row) => row.nominatedBy.map((item) => sentenceCase(item.analyst)).join(', '),
              mobilePriority: 'secondary',
            },
            {
              id: 'price',
              header: 'Last price',
              cell: (row) => formatUsd(row.lastPrice),
              align: 'right',
            },
            {
              id: 'liquidity',
              header: '20-day average dollar volume',
              cell: (row) => formatUsd(row.avgDollarVolume20d),
              align: 'right',
              mobilePriority: 'secondary',
            },
          ]}
          rowKey={(row) => row.ticker}
          rowLabel={(row) => 'Inspect ' + row.ticker + ' research'}
          selectedKey={selection.selectedKey}
          onSelect={(row) => selectSymbol({ symbol: row.ticker })}
          emptyMessage="No candidates were recorded."
        />
      ) : null}
      {tab === 'filtered' ? (
        <DataTable
          ariaLabel="Filtered-out symbols"
          rows={filteredRows}
          columns={[
            { id: 'symbol', header: 'Symbol', cell: (row) => row.symbol },
            { id: 'reason', header: 'Rule', cell: (row) => row.reason },
          ]}
          rowKey={symbolKey}
          rowLabel={(row) => 'Inspect ' + row.symbol + ' research'}
          selectedKey={selection.selectedKey}
          onSelect={selectSymbol}
          emptyMessage="No symbols were filtered out."
        />
      ) : null}
      {tab === 'offhours' ? (
        <DataTable
          ariaLabel="Off-hours trading plan"
          rows={offhoursRows}
          columns={basicColumns}
          rowKey={symbolKey}
          rowLabel={(row) => 'Inspect ' + row.symbol + ' research'}
          selectedKey={selection.selectedKey}
          onSelect={selectSymbol}
          emptyMessage="No off-hours plan entries were recorded."
        />
      ) : null}
      {tab === 'rth' ? (
        <DataTable
          ariaLabel="Regular-session trading plan"
          rows={rthRows}
          columns={basicColumns}
          rowKey={symbolKey}
          rowLabel={(row) => 'Inspect ' + row.symbol + ' research'}
          selectedKey={selection.selectedKey}
          onSelect={selectSymbol}
          emptyMessage="No regular-session plan entries were recorded."
        />
      ) : null}
    </Pane>
  );

  const selectedViews = verdicts?.verdicts.filter((item) => item.ticker === selected) ?? [];
  const selectedCandidate =
    candidates?.candidates.find((item) => item.ticker === selected) ?? null;
  const selectedPlan = tab === 'rth'
    ? rthPlan
    : tab === 'offhours'
      ? offhoursPlan
      : offhoursPlan ?? rthPlan;
  const selectedEntry =
    selectedPlan?.entries.find((item) => item.ticker === selected) ?? null;
  const skipped =
    selectedPlan?.skipped.find((item) => item.ticker === selected) ?? null;

  const detail = (
    <Pane id="research-detail" title="Research detail" subtitle={selected ?? undefined}>
      {!selected ? (
        <StatusMessage tone="empty">There is no candidate to inspect.</StatusMessage>
      ) : (
        <div className="detail-stack">
          {selectedCandidate ? (
            <section>
              <h3>Nomination</h3>
              <dl className="definition-rows">
                <div><dt>Last price</dt><dd>{formatUsd(selectedCandidate.lastPrice)}</dd></div>
                <div>
                  <dt>20-day average dollar volume</dt>
                  <dd>{formatUsd(selectedCandidate.avgDollarVolume20d)}</dd>
                </div>
              </dl>
              <ul>
                {selectedCandidate.nominatedBy.map((item) => (
                  <li key={item.analyst + ':' + item.reason}>
                    {sentenceCase(item.analyst)} — {item.reason}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {selectedEntry ? (
            <>
              <p>{selectedEntry.narrative}</p>
              <dl className="definition-rows">
                <div>
                  <dt>Trading plan</dt>
                  <dd>{selectedPlan?.kind === 'rth' ? 'Regular session' : 'Off-hours'}</dd>
                </div>
                <div>
                  <dt>Generated</dt>
                  <dd>{selectedPlan ? formatEtTimestamp(selectedPlan.generatedAt) : 'Not recorded'}</dd>
                </div>
                <div>
                  <dt>Expires</dt>
                  <dd>{selectedPlan ? formatEtTimestamp(selectedPlan.expiresAt) : 'Not recorded'}</dd>
                </div>
                <div><dt>Position</dt><dd>{direction(selectedEntry.direction)}</dd></div>
                <div><dt>Confidence</dt><dd>{formatPercent(selectedEntry.weightedConviction)}</dd></div>
                <div>
                  <dt>Limit band</dt>
                  <dd>{formatUsd(selectedEntry.limitBand.low)}–{formatUsd(selectedEntry.limitBand.high)}</dd>
                </div>
                <div><dt>Target notional</dt><dd>{formatUsd(selectedEntry.targetNotionalUsd)}</dd></div>
              </dl>
            </>
          ) : (
            <p>
              No trading-plan entry for {selected}. {skipped?.reason ?? 'A reason was not recorded.'}
            </p>
          )}
          <DataTable
            ariaLabel={selected + ' analyst matrix'}
            rows={ANALYSTS.map((analyst) => ({
              analyst,
              view: selectedViews.find((item) => item.analyst === analyst) ?? null,
            }))}
            columns={[
              { id: 'analyst', header: 'Analyst', cell: (row) => sentenceCase(row.analyst) },
              {
                id: 'position',
                header: 'Position',
                cell: (row) => row.view ? direction(row.view.direction) : 'Not recorded',
              },
              {
                id: 'confidence',
                header: 'Confidence',
                cell: (row) => row.view ? formatPercent(row.view.conviction) : 'Not recorded',
                align: 'right',
              },
              {
                id: 'evidence',
                header: 'Evidence',
                cell: (row) => row.view?.evidence.join(' ') || 'Not recorded',
                mobilePriority: 'secondary',
              },
            ]}
            rowKey={(row) => row.analyst}
            emptyMessage="No analyst views were recorded."
          />
          <section>
            <h3>Invalidation conditions</h3>
            {selectedEntry?.invalidationConditions.length ? (
              <ul>
                {selectedEntry.invalidationConditions.map((item) => <li key={item}>{item}</li>)}
              </ul>
            ) : <p>Not recorded</p>}
          </section>
        </div>
      )}
    </Pane>
  );

  return (
    <main className="route route--research">
      <MasterDetail
        master={list}
        detail={detail}
        detailOpen={selection.detailOpen}
        detailLabel="Research detail"
        onDetailClose={selection.closeDetail}
      />
    </main>
  );
}
~~~

- [ ] **Step 3: Run and commit Research**

Run:

~~~bash
pnpm --dir frontend test -- src/views/ResearchView.test.tsx
~~~

Expected: PASS.

Keep frontend/src/views/ThesisView.tsx temporarily because the pre-shell App still imports it. Task 12 replaces App.tsx and removes all superseded route files atomically.

Commit:

~~~bash
git add frontend/src/views/ResearchView.tsx frontend/src/views/ResearchView.test.tsx
git commit -m "feat: replace thesis cards with research workspace"
~~~

---

### Task 8: Positions, Orders, and Risk Rejections Route

**Files:**
- Replace: frontend/src/views/PositionsView.tsx
- Create: frontend/src/views/PositionsView.test.tsx
- Modify: frontend/src/App.tsx

**Interfaces:**
- Consumes: PositionsResponse, OrdersResponse, AuditEvent[], buildRiskRejections(), humanizeBrokerStatus(), Pane, DataTable, MasterDetail, and useLinkedSelection().
- Produces: PositionsView with controlled Positions/Orders/Risk rejections tabs and full selected-row detail.

- [ ] **Step 1: Write failing route tests**

Create frontend/src/views/PositionsView.test.tsx:

~~~tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { auditFixture, ordersFixture, positionsFixture } from '../test/fixtures';
import { PositionsView } from './PositionsView';

describe('PositionsView', () => {
  it('uses tabs instead of vertically stacked cards', async () => {
    render(
      <PositionsView
        positions={positionsFixture}
        orders={ordersFixture}
        audit={auditFixture}
        now={new Date('2026-07-12T18:00:00.000Z')}
      />,
    );
    expect(screen.getByRole('tab', { name: 'Positions' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await userEvent.click(screen.getByRole('tab', { name: 'Orders' }));
    expect(screen.getByRole('table', { name: 'Orders' })).toBeVisible();
    expect(screen.getByText('Filled')).toBeVisible();

    await userEvent.click(screen.getByRole('tab', { name: 'Risk rejections' }));
    expect(screen.getByText('Spread exceeded 40 bps.')).toBeVisible();
  });

  it('uses the three exact empty states', async () => {
    render(
      <PositionsView
        positions={{ positions: [] }}
        orders={{ orders: [] }}
        audit={[]}
        now={new Date('2026-07-12T18:00:00.000Z')}
      />,
    );
    expect(screen.getByText('No open positions.')).toBeVisible();
    await userEvent.click(screen.getByRole('tab', { name: 'Orders' }));
    expect(screen.getByText('No orders were submitted today.')).toBeVisible();
    await userEvent.click(screen.getByRole('tab', { name: 'Risk rejections' }));
    expect(screen.getByText('No orders were rejected by the risk checks today.')).toBeVisible();
  });

  it('does not describe failed broker reads as empty account state', async () => {
    render(
      <PositionsView
        positions={{ positions: [], error: 'Broker credentials are missing.' }}
        orders={{ orders: [], error: 'Broker credentials are missing.' }}
        audit={[]}
        now={new Date('2026-07-12T18:00:00.000Z')}
      />,
    );
    expect(screen.getByText(/Position data is unavailable/)).toBeVisible();
    expect(screen.queryByText('No open positions.')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'Orders' }));
    expect(screen.getByText(/Order data is unavailable/)).toBeVisible();
    expect(screen.queryByText('No orders were submitted today.')).not.toBeInTheDocument();
  });
});
~~~

Run:

~~~bash
pnpm --dir frontend test -- src/views/PositionsView.test.tsx
~~~

Expected: FAIL because the existing route uses stacked Card components and the old language.

- [ ] **Step 2: Replace PositionsView with a tabbed master-detail table**

Replace frontend/src/views/PositionsView.tsx:

~~~tsx
import { useMemo, useState } from 'react';
import { DataTable } from '../components/workspace/DataTable';
import { MasterDetail } from '../components/workspace/MasterDetail';
import { Pane } from '../components/workspace/Pane';
import { StatusMessage } from '../components/workspace/StatusMessage';
import { useLinkedSelection } from '../hooks/useLinkedSelection';
import { formatEtTimestamp, formatUsd, sentenceCase } from '../presentation/format';
import {
  buildRiskRejections,
  humanizeBrokerStatus,
  type RiskRejectionRow,
} from '../presentation/positions';
import type {
  AuditEvent,
  BrokerOrder,
  OrdersResponse,
  Position,
  PositionsResponse,
} from '../types';

export interface PositionsViewProps {
  positions: PositionsResponse;
  orders: OrdersResponse;
  audit: readonly AuditEvent[];
  now?: Date;
}

type PositionRow =
  | { kind: 'position'; key: string; value: Position }
  | { kind: 'order'; key: string; value: BrokerOrder }
  | { kind: 'rejection'; key: string; value: RiskRejectionRow };

function rowKey(row: PositionRow): string {
  return row.key;
}

export function PositionsView({
  positions,
  orders,
  audit,
  now = new Date(),
}: PositionsViewProps) {
  const [tab, setTab] = useState('positions');
  const rejections = useMemo(() => buildRiskRejections(audit, now), [audit, now]);
  const rows: PositionRow[] = tab === 'positions'
    ? positions.positions.map((value) => ({ kind: 'position', key: value.ticker, value }))
    : tab === 'orders'
      ? orders.orders.map((value) => ({ kind: 'order', key: value.id, value }))
      : rejections.map((value) => ({ kind: 'rejection', key: value.id, value }));
  const selection = useLinkedSelection(rows, rowKey);

  const table = (
    <Pane
      id="positions-workspace"
      title="Positions"
      tabs={[
        { id: 'positions', label: 'Positions' },
        { id: 'orders', label: 'Orders' },
        { id: 'rejections', label: 'Risk rejections' },
      ]}
      activeTab={tab}
      onTabChange={(next) => {
        setTab(next);
        selection.closeDetail();
      }}
    >
      {tab === 'positions' && positions.error ? (
        <StatusMessage tone="error" announce="polite">
          Position data is unavailable. {positions.error} No position state was confirmed.
        </StatusMessage>
      ) : null}
      {tab === 'positions' && !positions.error ? (
        <DataTable
          ariaLabel="Open positions"
          rows={positions.positions}
          columns={[
            { id: 'symbol', header: 'Symbol', cell: (row) => row.ticker },
            { id: 'side', header: 'Side', cell: (row) => sentenceCase(row.side) },
            { id: 'quantity', header: 'Quantity', cell: (row) => row.qty, align: 'right' },
            {
              id: 'value',
              header: 'Market value',
              cell: (row) => formatUsd(row.marketValue),
              align: 'right',
              mobilePriority: 'secondary',
            },
            {
              id: 'pnl',
              header: 'Open gain/loss',
              cell: (row) => formatUsd(row.unrealizedPl),
              align: 'right',
              mobilePriority: 'secondary',
            },
          ]}
          rowKey={(row) => row.ticker}
          rowLabel={(row) => 'Inspect ' + row.ticker + ' position'}
          selectedKey={selection.selectedItem?.kind === 'position'
            ? selection.selectedItem.key
            : null}
          onSelect={(value) => selection.select({ kind: 'position', key: value.ticker, value })}
          emptyMessage="No open positions."
        />
      ) : null}
      {tab === 'orders' && orders.error ? (
        <StatusMessage tone="error" announce="polite">
          Order data is unavailable. {orders.error} No order state was confirmed.
        </StatusMessage>
      ) : null}
      {tab === 'orders' && !orders.error ? (
        <DataTable
          ariaLabel="Orders"
          rows={orders.orders}
          columns={[
            { id: 'symbol', header: 'Symbol', cell: (row) => row.ticker },
            { id: 'side', header: 'Side', cell: (row) => sentenceCase(row.side) },
            {
              id: 'quantity',
              header: 'Quantity',
              cell: (row) => row.qty,
              align: 'right',
              mobilePriority: 'secondary',
            },
            { id: 'status', header: 'Status', cell: (row) => humanizeBrokerStatus(row.status) },
            {
              id: 'time',
              header: 'Submitted (ET)',
              cell: (row) => formatEtTimestamp(row.submittedAt),
              mobilePriority: 'secondary',
            },
          ]}
          rowKey={(row) => row.id}
          rowLabel={(row) => 'Inspect order ' + row.id}
          selectedKey={selection.selectedItem?.kind === 'order'
            ? selection.selectedItem.key
            : null}
          onSelect={(value) => selection.select({ kind: 'order', key: value.id, value })}
          emptyMessage="No orders were submitted today."
        />
      ) : null}
      {tab === 'rejections' ? (
        <DataTable
          ariaLabel="Risk rejections"
          rows={rejections}
          columns={[
            { id: 'symbol', header: 'Symbol', cell: (row) => row.symbol },
            {
              id: 'time',
              header: 'Time (ET)',
              cell: (row) => row.timestamp,
              mobilePriority: 'secondary',
            },
            { id: 'reason', header: 'Reason', cell: (row) => row.reason },
          ]}
          rowKey={(row) => row.id}
          rowLabel={(row) => 'Inspect ' + row.symbol + ' rejection'}
          selectedKey={selection.selectedItem?.kind === 'rejection'
            ? selection.selectedItem.key
            : null}
          onSelect={(value) => selection.select({ kind: 'rejection', key: value.id, value })}
          emptyMessage="No orders were rejected by the risk checks today."
        />
      ) : null}
    </Pane>
  );

  const selected = selection.selectedItem;
  const detail = (
    <Pane id="position-detail" title="Detail">
      {!selected ? (
        <StatusMessage tone="empty">Select a row to inspect its recorded fields.</StatusMessage>
      ) : selected.kind === 'position' ? (
        <dl className="definition-rows">
          <div><dt>Symbol</dt><dd>{selected.value.ticker}</dd></div>
          <div><dt>Side</dt><dd>{sentenceCase(selected.value.side)}</dd></div>
          <div><dt>Quantity</dt><dd>{selected.value.qty}</dd></div>
          <div><dt>Average entry</dt><dd>{formatUsd(selected.value.avgEntryPrice)}</dd></div>
          <div><dt>Market value</dt><dd>{formatUsd(selected.value.marketValue)}</dd></div>
          <div><dt>Open gain/loss</dt><dd>{formatUsd(selected.value.unrealizedPl)}</dd></div>
        </dl>
      ) : selected.kind === 'order' ? (
        <dl className="definition-rows">
          <div><dt>Order ID</dt><dd>{selected.value.id}</dd></div>
          <div><dt>Client order ID</dt><dd>{selected.value.clientOrderId ?? 'Not recorded'}</dd></div>
          <div><dt>Raw broker status</dt><dd>{selected.value.status}</dd></div>
          <div><dt>Submitted</dt><dd>{formatEtTimestamp(selected.value.submittedAt)}</dd></div>
          <div><dt>Limit price</dt><dd>{formatUsd(selected.value.limitPrice)}</dd></div>
          <div><dt>Stop price</dt><dd>{formatUsd(selected.value.stopPrice)}</dd></div>
          <div><dt>Filled quantity</dt><dd>{selected.value.filledQty ?? 'Not recorded'}</dd></div>
        </dl>
      ) : (
        <div className="detail-stack">
          <p>{selected.value.reason}</p>
          <pre>{JSON.stringify(selected.value.raw, null, 2)}</pre>
        </div>
      )}
    </Pane>
  );

  return (
    <main className="route route--positions">
      <MasterDetail
        master={table}
        detail={detail}
        detailOpen={selection.detailOpen}
        detailLabel="Position and order detail"
        onDetailClose={selection.closeDetail}
      />
    </main>
  );
}

export default PositionsView;
~~~

- [ ] **Step 3: Keep the pre-shell App compiling against the new route contract**

In frontend/src/App.tsx replace only the existing PositionsView call:

~~~tsx
{view === 'positions' && (
  <PositionsView positions={d.positions} orders={d.orders} audit={d.audit} />
)}
~~~

- [ ] **Step 4: Run and commit Positions**

Run:

~~~bash
pnpm --dir frontend test -- src/views/PositionsView.test.tsx
pnpm --dir frontend build
~~~

Expected: route tests and build pass.

Commit:

~~~bash
git add frontend/src/views/PositionsView.tsx frontend/src/views/PositionsView.test.tsx frontend/src/App.tsx
git commit -m "feat: unify positions orders and risk rejections"
~~~

---

### Task 9: Evidence-Only Backtest Route

**Files:**
- Replace: frontend/src/views/BacktestView.tsx
- Create: frontend/src/views/BacktestView.test.tsx
- Modify: frontend/src/App.tsx

**Interfaces:**
- Consumes: BacktestResponse, buildBacktestPoints(), Pane, DataTable, and StatusMessage.
- Produces: BacktestView with data-backed P&L chart, sweep table, and trade log; no unsupported dates, episode count, capital, SIP claim, denominator, or statistical conclusion.

- [ ] **Step 1: Write failing Backtest tests**

Create frontend/src/views/BacktestView.test.tsx:

~~~tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { backtestFixture } from '../test/fixtures';
import { BacktestView } from './BacktestView';

describe('BacktestView', () => {
  it('shows only API-backed metadata and values', () => {
    render(<BacktestView backtest={backtestFixture} />);
    expect(screen.getByText('july-sweep')).toBeVisible();
    expect(screen.getByRole('img', { name: 'Net P&L by confidence threshold' })).toBeVisible();
    expect(screen.queryByText(/50 episodes/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/starting capital/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/statistically/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/SIP/i)).not.toBeInTheDocument();
  });

  it('reaches the sweep and trade log through tabs', async () => {
    render(<BacktestView backtest={backtestFixture} />);
    await userEvent.click(screen.getByRole('tab', { name: 'Sweep' }));
    expect(screen.getByRole('table', { name: 'Backtest sweep' })).toBeVisible();
    await userEvent.click(screen.getByRole('tab', { name: 'Trade log' }));
    expect(screen.getByRole('table', { name: 'Backtest trade log' })).toBeVisible();
  });

  it('states when no backtest result is available', () => {
    render(<BacktestView backtest={{ available: false }} />);
    expect(screen.getByText('No backtest result is available.')).toBeVisible();
  });
});
~~~

Run:

~~~bash
pnpm --dir frontend test -- src/views/BacktestView.test.tsx
~~~

Expected: FAIL because the old route contains unsupported hard-coded claims and old Card primitives.

- [ ] **Step 2: Replace BacktestView with flat analytical tabs**

Replace frontend/src/views/BacktestView.tsx:

~~~tsx
import { useState } from 'react';
import { DataTable } from '../components/workspace/DataTable';
import { Pane } from '../components/workspace/Pane';
import { StatusMessage } from '../components/workspace/StatusMessage';
import { buildBacktestPoints } from '../presentation/backtest';
import { formatEtTimestamp, formatPercent, formatUsd, sentenceCase } from '../presentation/format';
import type { BacktestResponse } from '../types';

export interface BacktestViewProps {
  backtest: BacktestResponse | null;
}

function PnlChart({ backtest }: { backtest: BacktestResponse }) {
  const points = buildBacktestPoints(backtest.cells ?? []);
  if (points.length === 0) {
    return <StatusMessage tone="empty">No threshold cells were returned.</StatusMessage>;
  }
  const width = 720;
  const height = 260;
  const padding = 32;
  const pnls = points.map((point) => point.pnl);
  const min = Math.min(0, ...pnls);
  const max = Math.max(0, ...pnls);
  const range = Math.max(1, max - min);
  const coordinates = points.map((point, index) => {
    const x = points.length === 1
      ? width / 2
      : padding + index * ((width - padding * 2) / (points.length - 1));
    const y = height - padding - ((point.pnl - min) / range) * (height - padding * 2);
    return { ...point, x, y };
  });
  const zeroY = height - padding - ((0 - min) / range) * (height - padding * 2);
  return (
    <figure className="backtest-chart">
      <svg
        viewBox={'0 0 ' + width + ' ' + height}
        role="img"
        aria-label="Net P&L by confidence threshold"
      >
        <line x1={padding} x2={width - padding} y1={zeroY} y2={zeroY} className="chart-zero" />
        <polyline
          points={coordinates.map((point) => point.x + ',' + point.y).join(' ')}
          className="chart-line"
        />
        {coordinates.map((point) => (
          <circle key={point.key} cx={point.x} cy={point.y} r="3">
            <title>{formatPercent(point.threshold) + ': ' + formatUsd(point.pnl)}</title>
          </circle>
        ))}
      </svg>
      <figcaption>Net P&amp;L returned for each confidence threshold.</figcaption>
    </figure>
  );
}

export function BacktestView({ backtest }: BacktestViewProps) {
  const [tab, setTab] = useState('pnl');
  if (!backtest?.available) {
    return (
      <main className="route route--backtest">
        <Pane id="backtest" title="Backtest">
          <StatusMessage tone="empty">No backtest result is available.</StatusMessage>
        </Pane>
      </main>
    );
  }
  return (
    <main className="route route--backtest">
      <Pane
        id="backtest"
        title="Backtest"
        subtitle={backtest.tag ?? 'Tag not recorded'}
        toolbar={backtest.generatedAt
          ? <span>Generated {formatEtTimestamp(backtest.generatedAt)}</span>
          : null}
        tabs={[
          { id: 'pnl', label: 'P&L by threshold' },
          { id: 'sweep', label: 'Sweep' },
          { id: 'trades', label: 'Trade log' },
        ]}
        activeTab={tab}
        onTabChange={setTab}
      >
        {tab === 'pnl' ? <PnlChart backtest={backtest} /> : null}
        {tab === 'sweep' ? (
          <DataTable
            ariaLabel="Backtest sweep"
            rows={backtest.cells ?? []}
            columns={[
              { id: 'cell', header: 'Cell', cell: (row) => row.cell },
              {
                id: 'threshold',
                header: 'Confidence threshold',
                cell: (row) => formatPercent(row.threshold),
                align: 'right',
              },
              { id: 'abstained', header: 'Abstained', cell: (row) => row.abstained, align: 'right' },
              { id: 'placed', header: 'Orders placed', cell: (row) => row.ordersPlaced, align: 'right' },
              { id: 'filled', header: 'Orders filled', cell: (row) => row.ordersFilled, align: 'right' },
              { id: 'trades', header: 'Trades', cell: (row) => row.trades, align: 'right' },
              { id: 'pnl', header: 'Net P&L', cell: (row) => formatUsd(row.netPnlUsd), align: 'right' },
            ]}
            rowKey={(row) => row.cell}
            emptyMessage="No threshold cells were returned."
          />
        ) : null}
        {tab === 'trades' ? (
          <div className="detail-stack">
            <p>Trade-log cell: {backtest.tradeLogCell ?? 'Not recorded'}</p>
            <DataTable
              ariaLabel="Backtest trade log"
              rows={backtest.trades ?? []}
              columns={[
                { id: 'day', header: 'Day', cell: (row) => row.day },
                { id: 'stratum', header: 'Stratum', cell: (row) => row.stratum },
                { id: 'symbol', header: 'Symbol', cell: (row) => row.ticker },
                { id: 'side', header: 'Side', cell: (row) => sentenceCase(row.side) },
                { id: 'quantity', header: 'Quantity', cell: (row) => row.qty, align: 'right' },
                { id: 'entry', header: 'Entry', cell: (row) => formatUsd(row.entryPrice), align: 'right' },
                { id: 'exit', header: 'Exit', cell: (row) => formatUsd(row.exitPrice), align: 'right' },
                { id: 'pnl', header: 'P&L', cell: (row) => formatUsd(row.pnlUsd), align: 'right' },
                { id: 'reason', header: 'Exit reason', cell: (row) => sentenceCase(row.exitReason) },
              ]}
              rowKey={(row) => [
                row.day, row.stratum, row.ticker, row.entryPrice, row.exitPrice,
              ].join(':')}
              emptyMessage="No trades were returned for the selected cell."
            />
          </div>
        ) : null}
      </Pane>
    </main>
  );
}

export default BacktestView;
~~~

- [ ] **Step 3: Keep the pre-shell App compiling against the new route contract**

In frontend/src/App.tsx replace only the existing BacktestView call:

~~~tsx
{view === 'backtest' && <BacktestView backtest={d.backtest} />}
~~~

- [ ] **Step 4: Run and commit Backtest**

Run:

~~~bash
pnpm --dir frontend test -- src/views/BacktestView.test.tsx
pnpm --dir frontend build
~~~

Expected: route tests and build pass.

Commit:

~~~bash
git add frontend/src/views/BacktestView.tsx frontend/src/views/BacktestView.test.tsx frontend/src/App.tsx
git commit -m "feat: make backtest evidence-only"
~~~

---

### Task 10: Protected Configuration Draft and Grouped Route

**Files:**
- Create: frontend/src/views/config/configDraft.ts
- Create: frontend/src/views/config/configDraft.test.ts
- Create: frontend/src/views/config/useConfigDraft.ts
- Create: frontend/src/views/ConfigurationView.tsx
- Create: frontend/src/views/ConfigurationView.test.tsx

**Interfaces:**
- Consumes: Config, AnalystName, ApiResult<Config>, Pane, and StatusMessage.
- Produces: ConfigDraft, ConfigDraftState, configDraftReducer(), toConfigDraft(), toConfigPayload(), useConfigDraft(), ConfigDraftController, and ConfigurationView.

- [ ] **Step 1: Write failing protected-draft reducer tests**

Create frontend/src/views/config/configDraft.test.ts:

~~~ts
import { describe, expect, it } from 'vitest';
import { configFixture } from '../../test/fixtures';
import {
  configDraftReducer,
  createConfigDraftState,
  toConfigPayload,
} from './configDraft';

describe('configDraftReducer', () => {
  it('ignores an identical poll without marking server data newer', () => {
    const state = createConfigDraftState(configFixture);
    const next = configDraftReducer(state, {
      type: 'serverReceived',
      config: configFixture,
    });
    expect(next).toBe(state);
    expect(next.incoming).toBeNull();
  });

  it('adopts a changed poll while clean', () => {
    const state = createConfigDraftState(configFixture);
    const nextConfig = { ...configFixture, conviction_threshold: 0.75 };
    const next = configDraftReducer(state, { type: 'serverReceived', config: nextConfig });
    expect(next.draft?.conviction_threshold).toBe('0.75');
    expect(next.phase).toBe('clean');
    expect(next.incoming).toBeNull();
  });

  it('preserves a dirty draft and retains newer server data separately', () => {
    const dirty = configDraftReducer(createConfigDraftState(configFixture), {
      type: 'patch',
      patch: { conviction_threshold: '0.82' },
    });
    const nextConfig = { ...configFixture, conviction_threshold: 0.75 };
    const next = configDraftReducer(dirty, { type: 'serverReceived', config: nextConfig });
    expect(next.draft?.conviction_threshold).toBe('0.82');
    expect(next.incoming?.conviction_threshold).toBe(0.75);
  });

  it('discards local edits into the newest server version', () => {
    const dirty = configDraftReducer(createConfigDraftState(configFixture), {
      type: 'patch',
      patch: { conviction_threshold: '0.82' },
    });
    const withIncoming = configDraftReducer(dirty, {
      type: 'serverReceived',
      config: { ...configFixture, conviction_threshold: 0.75 },
    });
    const discarded = configDraftReducer(withIncoming, { type: 'discard' });
    expect(discarded.draft?.conviction_threshold).toBe('0.75');
    expect(discarded.phase).toBe('clean');
  });

  it('builds a payload with latest read-only mode and acknowledgment', () => {
    const state = configDraftReducer(createConfigDraftState(configFixture), {
      type: 'patch',
      patch: { conviction_threshold: '0.82' },
    });
    const server = {
      ...configFixture,
      mode: 'dry-run' as const,
      live_trading_acknowledged: true,
    };
    expect(toConfigPayload(state.draft!, server)).toMatchObject({
      mode: 'dry-run',
      live_trading_acknowledged: true,
      conviction_threshold: 0.82,
    });
  });
});
~~~

Run:

~~~bash
pnpm --dir frontend test -- src/views/config/configDraft.test.ts
~~~

Expected: FAIL because the reducer does not exist.

- [ ] **Step 2: Implement the complete draft contract and reducer**

Create frontend/src/views/config/configDraft.ts:

~~~ts
import type { AnalystName, Config } from '../../types';

export interface ConfigDraft {
  nominations_per_agent: string;
  max_candidates: string;
  min_price: string;
  min_avg_dollar_volume: string;
  exclude: string[];
  premarket: boolean;
  afterhours: boolean;
  regularhours: boolean;
  data_feed: 'iex' | 'sip';
  weights: Record<AnalystName, number>;
  conviction_threshold: string;
  quorum: string;
  min_agreeing: string;
  max_position_pct: string;
  max_daily_deploy_pct: string;
  max_order_notional_usd: string;
  max_spread_bps: string;
  max_chase_pct: string;
  max_drop_pct: string;
  target_vol_pct: string;
  max_position_loss_pct: string;
  max_quote_age_sec: string;
  daily_loss_halt_pct: string;
  executor_interval_min: string;
  thesis_run_time_et: string;
  model_analysts: string;
  model_synthesizer: string;
  model_executor: string;
}

export type ConfigDraftPhase =
  | 'loading'
  | 'clean'
  | 'dirty'
  | 'saving'
  | 'saved'
  | 'error';

export interface ConfigDraftState {
  baseline: Config | null;
  draft: ConfigDraft | null;
  incoming: Config | null;
  phase: ConfigDraftPhase;
  message: string | null;
}

export type ConfigDraftAction =
  | { type: 'serverReceived'; config: Config }
  | { type: 'patch'; patch: Partial<ConfigDraft> }
  | { type: 'discard' }
  | { type: 'saveStarted' }
  | { type: 'saveSucceeded'; config: Config }
  | { type: 'saveFailed'; message: string };

function equalConfig(a: Config | null, b: Config | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function toConfigDraft(config: Config): ConfigDraft {
  return {
    nominations_per_agent: String(config.universe.nominations_per_agent),
    max_candidates: String(config.universe.max_candidates),
    min_price: String(config.universe.min_price),
    min_avg_dollar_volume: String(config.universe.min_avg_dollar_volume),
    exclude: [...config.universe.exclude],
    premarket: config.sessions.premarket,
    afterhours: config.sessions.afterhours,
    regularhours: config.sessions.regularhours,
    data_feed: config.data_feed,
    weights: { ...config.agent_weights },
    conviction_threshold: String(config.conviction_threshold),
    quorum: String(config.quorum),
    min_agreeing: String(config.min_agreeing),
    max_position_pct: String(config.max_position_pct),
    max_daily_deploy_pct: String(config.max_daily_deploy_pct),
    max_order_notional_usd: String(config.max_order_notional_usd),
    max_spread_bps: String(config.max_spread_bps),
    max_chase_pct: String(config.max_chase_pct),
    max_drop_pct: String(config.max_drop_pct),
    target_vol_pct: String(config.target_vol_pct),
    max_position_loss_pct: String(config.max_position_loss_pct),
    max_quote_age_sec: String(config.max_quote_age_sec),
    daily_loss_halt_pct: String(config.daily_loss_halt_pct),
    executor_interval_min: String(config.executor_interval_min),
    thesis_run_time_et: config.thesis_run_time_et,
    model_analysts: config.model.analysts,
    model_synthesizer: config.model.synthesizer,
    model_executor: config.model.executor,
  };
}

export function toConfigPayload(draft: ConfigDraft, latestServer: Config): Config {
  return {
    mode: latestServer.mode,
    live_trading_acknowledged: latestServer.live_trading_acknowledged,
    universe: {
      nominations_per_agent: Number(draft.nominations_per_agent),
      max_candidates: Number(draft.max_candidates),
      min_price: Number(draft.min_price),
      min_avg_dollar_volume: Number(draft.min_avg_dollar_volume),
      exclude: draft.exclude,
    },
    sessions: {
      premarket: draft.premarket,
      afterhours: draft.afterhours,
      regularhours: draft.regularhours,
    },
    agent_weights: draft.weights,
    conviction_threshold: Number(draft.conviction_threshold),
    quorum: Number(draft.quorum),
    min_agreeing: Number(draft.min_agreeing),
    max_position_pct: Number(draft.max_position_pct),
    max_daily_deploy_pct: Number(draft.max_daily_deploy_pct),
    max_order_notional_usd: Number(draft.max_order_notional_usd),
    max_spread_bps: Number(draft.max_spread_bps),
    max_chase_pct: Number(draft.max_chase_pct),
    max_drop_pct: Number(draft.max_drop_pct),
    target_vol_pct: Number(draft.target_vol_pct),
    max_position_loss_pct: Number(draft.max_position_loss_pct),
    daily_loss_halt_pct: Number(draft.daily_loss_halt_pct),
    data_feed: draft.data_feed,
    max_quote_age_sec: Number(draft.max_quote_age_sec),
    executor_interval_min: Number(draft.executor_interval_min),
    thesis_run_time_et: draft.thesis_run_time_et,
    model: {
      analysts: draft.model_analysts,
      synthesizer: draft.model_synthesizer,
      executor: draft.model_executor,
    },
  };
}

export function createConfigDraftState(config: Config | null): ConfigDraftState {
  return {
    baseline: config,
    draft: config ? toConfigDraft(config) : null,
    incoming: null,
    phase: config ? 'clean' : 'loading',
    message: null,
  };
}

export function configDraftReducer(
  state: ConfigDraftState,
  action: ConfigDraftAction,
): ConfigDraftState {
  if (action.type === 'serverReceived') {
    if (equalConfig(action.config, state.baseline) || equalConfig(action.config, state.incoming)) {
      return state;
    }
    const protectedDraft = state.phase === 'dirty' || state.phase === 'saving' || state.phase === 'error';
    if (protectedDraft) return { ...state, incoming: action.config };
    return createConfigDraftState(action.config);
  }
  if (action.type === 'patch') {
    if (!state.draft) return state;
    return {
      ...state,
      draft: { ...state.draft, ...action.patch },
      phase: 'dirty',
      message: null,
    };
  }
  if (action.type === 'discard') {
    return createConfigDraftState(state.incoming ?? state.baseline);
  }
  if (action.type === 'saveStarted') {
    return { ...state, phase: 'saving', message: null };
  }
  if (action.type === 'saveSucceeded') {
    return {
      baseline: action.config,
      draft: toConfigDraft(action.config),
      incoming: null,
      phase: 'saved',
      message: 'Configuration saved.',
    };
  }
  return { ...state, phase: 'error', message: action.message };
}
~~~

- [ ] **Step 3: Implement the async draft controller**

Create frontend/src/views/config/useConfigDraft.ts:

~~~ts
import { useCallback, useEffect, useReducer } from 'react';
import type { ApiResult } from '../../api';
import type { Config } from '../../types';
import {
  configDraftReducer,
  createConfigDraftState,
  toConfigPayload,
  type ConfigDraft,
  type ConfigDraftPhase,
} from './configDraft';

export interface ConfigDraftController {
  draft: ConfigDraft | null;
  phase: ConfigDraftPhase;
  serverUpdateAvailable: boolean;
  message: string | null;
  patch(change: Partial<ConfigDraft>): void;
  discard(): void;
  save(): Promise<void>;
}

export function useConfigDraft(
  config: Config | null,
  onSave: (next: Config) => Promise<ApiResult<Config>>,
): ConfigDraftController {
  const [state, dispatch] = useReducer(configDraftReducer, config, createConfigDraftState);

  useEffect(() => {
    if (config) dispatch({ type: 'serverReceived', config });
  }, [config]);

  const save = useCallback(async () => {
    if (!state.draft || !state.baseline) return;
    dispatch({ type: 'saveStarted' });
    const result = await onSave(toConfigPayload(
      state.draft,
      state.incoming ?? state.baseline,
    ));
    if (result.ok) {
      dispatch({ type: 'saveSucceeded', config: result.data });
    } else {
      const trimmed = result.error.trim();
      const cause = /[.!?]$/.test(trimmed) ? trimmed : trimmed + '.';
      dispatch({
        type: 'saveFailed',
        message: 'Configuration was not saved. ' + cause + ' Review the highlighted field.',
      });
    }
  }, [onSave, state.baseline, state.draft, state.incoming]);

  return {
    draft: state.draft,
    phase: state.phase,
    serverUpdateAvailable: state.incoming !== null,
    message: state.message,
    patch(change) {
      dispatch({ type: 'patch', patch: change });
    },
    discard() {
      dispatch({ type: 'discard' });
    },
    save,
  };
}
~~~

- [ ] **Step 4: Write failing Configuration route tests**

Create frontend/src/views/ConfigurationView.test.tsx:

~~~tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { configFixture } from '../test/fixtures';
import { ConfigurationView } from './ConfigurationView';

describe('ConfigurationView', () => {
  it('protects a dirty field when newer server config arrives', async () => {
    const onSave = vi.fn();
    const { rerender } = render(
      <ConfigurationView config={configFixture} onSave={onSave} />,
    );
    const field = screen.getByLabelText('Confidence threshold');
    await userEvent.clear(field);
    await userEvent.type(field, '0.82');

    rerender(
      <ConfigurationView
        config={{ ...configFixture, conviction_threshold: 0.75 }}
        onSave={onSave}
      />,
    );
    expect(field).toHaveValue(0.82);
    expect(screen.getByText(
      'Newer server configuration is available. Your local edits have not been changed.',
    )).toBeVisible();

    await userEvent.click(screen.getByRole('button', { name: 'Discard local edits' }));
    expect(field).toHaveValue(0.75);
  });

  it('submits the dirty draft and announces a backend failure', async () => {
    const onSave = vi.fn().mockResolvedValue({
      ok: false,
      error: 'Confidence must be between 0 and 1.',
    });
    render(<ConfigurationView config={configFixture} onSave={onSave} />);
    const field = screen.getByLabelText('Confidence threshold');
    await userEvent.clear(field);
    await userEvent.type(field, '2');
    await userEvent.click(screen.getByRole('button', { name: 'Save configuration' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Configuration was not saved. Confidence must be between 0 and 1.',
    );
    expect(field).toHaveValue(2);
  });

  it('states that mode and acknowledgment are edited in config.yaml', () => {
    render(<ConfigurationView config={configFixture} onSave={vi.fn()} />);
    expect(screen.getByText(
      'Mode and live-trading acknowledgment are read-only here. Change both in config.yaml.',
    )).toBeVisible();
  });

  it('announces a successful save politely', async () => {
    const saved = { ...configFixture, conviction_threshold: 0.82 };
    const onSave = vi.fn().mockResolvedValue({ ok: true, data: saved });
    render(<ConfigurationView config={configFixture} onSave={onSave} />);
    const field = screen.getByLabelText('Confidence threshold');
    await userEvent.clear(field);
    await userEvent.type(field, '0.82');
    await userEvent.click(screen.getByRole('button', { name: 'Save configuration' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Configuration saved.');
  });
});
~~~

Run:

~~~bash
pnpm --dir frontend test -- src/views/config src/views/ConfigurationView.test.tsx
~~~

Expected: reducer tests pass after Steps 2–3; route tests fail because ConfigurationView.tsx does not exist.

- [ ] **Step 5: Implement grouped supported fields**

Create frontend/src/views/ConfigurationView.tsx:

~~~tsx
import { useState, type ReactNode } from 'react';
import type { ApiResult } from '../api';
import { Pane } from '../components/workspace/Pane';
import { StatusMessage } from '../components/workspace/StatusMessage';
import { sentenceCase } from '../presentation/format';
import { ANALYSTS, type Config } from '../types';
import { useConfigDraft } from './config/useConfigDraft';
import type { ConfigDraft } from './config/configDraft';

export interface ConfigurationViewProps {
  config: Config | null;
  onSave(next: Config): Promise<ApiResult<Config>>;
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="config-group">
      <h3>{title}</h3>
      <div className="config-fields">{children}</div>
    </section>
  );
}

function NumberField({
  label,
  name,
  value,
  step = '1',
  onChange,
}: {
  label: string;
  name: keyof ConfigDraft;
  value: string;
  step?: string;
  onChange(change: Partial<ConfigDraft>): void;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="number"
        step={step}
        value={value}
        onChange={(event) => onChange({
          [name]: event.target.value,
        } as Partial<ConfigDraft>)}
      />
    </label>
  );
}

function modeText(mode: Config['mode']): string {
  if (mode === 'dry-run') return 'Dry run';
  if (mode === 'paper') return 'Paper';
  return 'Live';
}

export function ConfigurationView({ config, onSave }: ConfigurationViewProps) {
  const controller = useConfigDraft(config, onSave);
  const [exclude, setExclude] = useState('');
  const draft = controller.draft;
  if (!config || !draft) {
    return (
      <main className="route route--configuration">
        <Pane id="configuration" title="Configuration">
          <StatusMessage tone="loading" announce="polite">Loading configuration.</StatusMessage>
        </Pane>
      </main>
    );
  }

  const addExclude = () => {
    const symbol = exclude.trim().toUpperCase();
    if (symbol && !draft.exclude.includes(symbol)) {
      controller.patch({ exclude: [...draft.exclude, symbol] });
    }
    setExclude('');
  };

  return (
    <main className="route route--configuration">
      <Pane
        id="configuration"
        title="Configuration"
        subtitle="Fields supported by this interface"
      >
        <div className="configuration">
          <section className="config-readonly">
            <dl className="definition-rows">
              <div><dt>Mode</dt><dd>{modeText(config.mode)}</dd></div>
              <div>
                <dt>Live-trading acknowledgment</dt>
                <dd>{config.live_trading_acknowledged ? 'Acknowledged' : 'Not acknowledged'}</dd>
              </div>
            </dl>
            <p>
              Mode and live-trading acknowledgment are read-only here. Change both in config.yaml.
            </p>
          </section>

          {controller.serverUpdateAvailable ? (
            <StatusMessage tone="stale" announce="polite">
              Newer server configuration is available. Your local edits have not been changed.
            </StatusMessage>
          ) : null}

          <Group title="Universe">
            <NumberField label="Nominations per analyst" name="nominations_per_agent"
              value={draft.nominations_per_agent} onChange={controller.patch} />
            <NumberField label="Maximum candidates" name="max_candidates"
              value={draft.max_candidates} onChange={controller.patch} />
            <NumberField label="Minimum price" name="min_price"
              value={draft.min_price} step="0.01" onChange={controller.patch} />
            <NumberField label="Minimum average dollar volume" name="min_avg_dollar_volume"
              value={draft.min_avg_dollar_volume} step="1000000" onChange={controller.patch} />
            <div className="field field--wide">
              <span>Excluded symbols</span>
              <div className="exclude-list">
                {draft.exclude.map((symbol) => (
                  <span className="exclude-item" key={symbol}>
                    {symbol}
                    <button
                      type="button"
                      aria-label={'Remove ' + symbol}
                      onClick={() => controller.patch({
                        exclude: draft.exclude.filter((item) => item !== symbol),
                      })}
                    >
                      Remove
                    </button>
                  </span>
                ))}
              </div>
              <div className="field-inline">
                <input
                  aria-label="Symbol to exclude"
                  value={exclude}
                  onChange={(event) => setExclude(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      addExclude();
                    }
                  }}
                />
                <button type="button" onClick={addExclude}>Add symbol</button>
              </div>
            </div>
          </Group>

          <Group title="Sessions and data">
            {([
              ['premarket', 'Premarket'],
              ['afterhours', 'After-hours'],
              ['regularhours', 'Regular session'],
            ] as const).map(([name, label]) => (
              <label className="check-field" key={name}>
                <input
                  type="checkbox"
                  checked={draft[name]}
                  onChange={(event) => controller.patch({
                    [name]: event.target.checked,
                  } as Partial<ConfigDraft>)}
                />
                <span>{label}</span>
              </label>
            ))}
            <label className="field">
              <span>Data feed</span>
              <select
                value={draft.data_feed}
                onChange={(event) => controller.patch({
                  data_feed: event.target.value as 'iex' | 'sip',
                })}
              >
                <option value="iex">IEX</option>
                <option value="sip">SIP</option>
              </select>
            </label>
            <NumberField label="Maximum quote age (seconds)" name="max_quote_age_sec"
              value={draft.max_quote_age_sec} onChange={controller.patch} />
          </Group>

          <Group title="Analyst weights">
            {ANALYSTS.map((analyst) => (
              <label className="field" key={analyst}>
                <span>{sentenceCase(analyst)}</span>
                <input
                  type="number"
                  min="0"
                  max="2"
                  step="0.1"
                  value={draft.weights[analyst]}
                  onChange={(event) => controller.patch({
                    weights: { ...draft.weights, [analyst]: Number(event.target.value) },
                  })}
                />
              </label>
            ))}
          </Group>

          <Group title="Decision rules">
            <NumberField label="Confidence threshold" name="conviction_threshold"
              value={draft.conviction_threshold} step="0.01" onChange={controller.patch} />
            <NumberField label="Required analyst count" name="quorum"
              value={draft.quorum} onChange={controller.patch} />
            <NumberField label="Minimum agreeing analysts" name="min_agreeing"
              value={draft.min_agreeing} onChange={controller.patch} />
          </Group>

          <Group title="Risk limits">
            {([
              ['max_position_pct', 'Maximum position fraction', '0.01'],
              ['max_daily_deploy_pct', 'Maximum daily deployment fraction', '0.01'],
              ['max_order_notional_usd', 'Maximum order notional (USD)', '100'],
              ['max_spread_bps', 'Maximum spread (bps)', '1'],
              ['max_chase_pct', 'Maximum chase fraction', '0.01'],
              ['max_drop_pct', 'Maximum drop fraction', '0.01'],
              ['target_vol_pct', 'Target volatility fraction', '0.01'],
              ['max_position_loss_pct', 'Maximum position loss fraction', '0.01'],
              ['daily_loss_halt_pct', 'Daily loss halt fraction', '0.01'],
            ] as const).map(([name, label, step]) => (
              <NumberField key={name} label={label} name={name}
                value={draft[name]} step={step} onChange={controller.patch} />
            ))}
          </Group>

          <Group title="Execution">
            <NumberField label="Execution-check interval (minutes)" name="executor_interval_min"
              value={draft.executor_interval_min} onChange={controller.patch} />
            <label className="field">
              <span>Analysis run time (ET)</span>
              <input
                type="time"
                value={draft.thesis_run_time_et}
                onChange={(event) => controller.patch({
                  thesis_run_time_et: event.target.value,
                })}
              />
            </label>
          </Group>

          <Group title="Models">
            {([
              ['model_analysts', 'Analyst model'],
              ['model_synthesizer', 'Trading-plan model'],
              ['model_executor', 'Executor model'],
            ] as const).map(([name, label]) => (
              <label className="field" key={name}>
                <span>{label}</span>
                <input
                  type="text"
                  value={draft[name]}
                  onChange={(event) => controller.patch({
                    [name]: event.target.value,
                  } as Partial<ConfigDraft>)}
                />
              </label>
            ))}
          </Group>

          <div className="configuration__actions">
            <button
              type="button"
              onClick={controller.discard}
              disabled={controller.phase === 'clean' || controller.phase === 'loading'}
            >
              Discard local edits
            </button>
            <button
              type="button"
              className="is-primary"
              onClick={() => void controller.save()}
              disabled={controller.phase !== 'dirty' && controller.phase !== 'error'}
            >
              {controller.phase === 'saving' ? 'Saving…' : 'Save configuration'}
            </button>
          </div>
          {controller.phase === 'saved' && controller.message ? (
            <StatusMessage tone="success" announce="polite">{controller.message}</StatusMessage>
          ) : null}
          {controller.phase === 'error' && controller.message ? (
            <StatusMessage tone="error" announce="assertive">{controller.message}</StatusMessage>
          ) : null}
        </div>
      </Pane>
    </main>
  );
}
~~~

- [ ] **Step 6: Run and commit Configuration**

Run:

~~~bash
pnpm --dir frontend test -- src/views/config src/views/ConfigurationView.test.tsx
pnpm --dir frontend build
~~~

Expected: reducer/controller route tests and build pass.

Keep frontend/src/views/ConfigView.tsx temporarily because the pre-shell App still imports it. Task 12 replaces App.tsx and removes all superseded route files atomically.

Commit:

~~~bash
git add frontend/src/views/config frontend/src/views/ConfigurationView.tsx frontend/src/views/ConfigurationView.test.tsx
git commit -m "feat: protect configuration drafts"
~~~

---

### Task 11: Parsed and Expandable Audit Route

**Files:**
- Replace: frontend/src/views/AuditView.tsx
- Create: frontend/src/views/AuditView.test.tsx
- Modify: frontend/src/App.tsx

**Interfaces:**
- Consumes: AuditEvent[], presentAuditEvent(), Pane, DataTable, and StatusMessage.
- Produces: AuditView with activity/status filters, human-readable cells, aria-expanded structured detail, raw kind, and raw JSON.

- [ ] **Step 1: Write failing Audit route tests**

Create frontend/src/views/AuditView.test.tsx:

~~~tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { AuditEvent } from '../types';
import { AuditView } from './AuditView';

const events: AuditEvent[] = [
  {
    ts: '2026-07-12T14:00:00.000Z',
    kind: 'order_rejected',
    data: { ticker: 'AMD', reason: 'Quote was stale.' },
  },
  {
    ts: '2026-07-12T14:01:00.000Z',
    kind: 'broker_heartbeat',
    data: { ok: true },
  },
];

describe('AuditView', () => {
  it('keeps an unknown event visible and expands its raw kind and JSON', async () => {
    render(<AuditView events={events} />);
    expect(screen.getByText('Unknown event')).toBeVisible();
    const row = screen.getByRole('row', { name: /Unknown event/ });
    await userEvent.click(row);
    expect(row).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('broker_heartbeat')).toBeVisible();
    expect(screen.getByText(/"ok": true/)).toBeVisible();
  });

  it('filters by status without dropping raw records', async () => {
    render(<AuditView events={events} />);
    await userEvent.selectOptions(screen.getByLabelText('Filter by status'), 'rejected');
    expect(screen.getByText('Order rejected')).toBeVisible();
    expect(screen.queryByText('Unknown event')).not.toBeInTheDocument();
  });
});
~~~

Run:

~~~bash
pnpm --dir frontend test -- src/views/AuditView.test.tsx
~~~

Expected: FAIL because the existing route does not preserve unknown kinds or provide the specified filters and expansion.

- [ ] **Step 2: Replace AuditView**

Replace frontend/src/views/AuditView.tsx:

~~~tsx
import { useMemo, useState } from 'react';
import { DataTable, type DataColumn } from '../components/workspace/DataTable';
import { Pane } from '../components/workspace/Pane';
import { presentAuditEvent, type PresentedAuditEvent } from '../presentation/audit';
import { sentenceCase } from '../presentation/format';
import type { AuditEvent } from '../types';

export interface AuditViewProps {
  events: readonly AuditEvent[];
}

export function AuditView({ events }: AuditViewProps) {
  const [activityFilter, setActivityFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const allRows = useMemo(
    () => events
      .map((event, index) => presentAuditEvent(event, index))
      .sort((a, b) => b.id.localeCompare(a.id)),
    [events],
  );
  const activityOptions = [...new Set(allRows.map((row) => row.activity))].sort();
  const rows = allRows.filter((row) =>
    (activityFilter === 'all' || row.activity === activityFilter) &&
    (statusFilter === 'all' || row.status === statusFilter),
  );
  const columns: DataColumn<PresentedAuditEvent>[] = [
    { id: 'time', header: 'Time (ET)', cell: (row) => row.timestamp },
    { id: 'activity', header: 'Activity', cell: (row) => row.activity },
    {
      id: 'stage',
      header: 'Stage',
      cell: (row) => row.stage,
      mobilePriority: 'secondary',
    },
    { id: 'status', header: 'Status', cell: (row) => sentenceCase(row.status) },
    {
      id: 'description',
      header: 'What happened',
      cell: (row) => row.description,
      mobilePriority: 'secondary',
    },
  ];

  return (
    <main className="route route--audit">
      <Pane
        id="audit"
        title="Audit"
        toolbar={(
          <div className="table-filters">
            <label>
              <span>Filter by activity</span>
              <select
                value={activityFilter}
                onChange={(event) => setActivityFilter(event.target.value)}
              >
                <option value="all">All activity</option>
                {activityOptions.map((activity) => (
                  <option value={activity} key={activity}>{activity}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Filter by status</span>
              <select
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value)}
              >
                <option value="all">All statuses</option>
                {['completed', 'skipped', 'rejected', 'failed', 'halted', 'pending', 'unknown']
                  .map((status) => (
                    <option value={status} key={status}>{sentenceCase(status)}</option>
                  ))}
              </select>
            </label>
          </div>
        )}
      >
        <DataTable
          ariaLabel="Audit events"
          rows={rows}
          columns={columns}
          rowKey={(row) => row.id}
          rowLabel={(row) => row.timestamp + ' ' + row.activity + ' ' + row.description}
          emptyMessage="No audit events match these filters."
          expandedKey={expandedKey}
          onToggleExpanded={(row) => setExpandedKey(expandedKey === row.id ? null : row.id)}
          renderExpanded={(row) => (
            <div className="audit-detail">
              <p>{row.description}</p>
              <dl className="definition-rows">
                <div><dt>Timestamp</dt><dd>{row.timestamp}</dd></div>
                <div><dt>Event kind</dt><dd>{row.rawKind}</dd></div>
                <div><dt>Known event</dt><dd>{row.knownKind ? 'Yes' : 'No'}</dd></div>
                {row.fields.map((field) => (
                  <div key={field.label}><dt>{field.label}</dt><dd>{field.value}</dd></div>
                ))}
              </dl>
              <pre>{row.rawJson}</pre>
            </div>
          )}
        />
      </Pane>
    </main>
  );
}

export default AuditView;
~~~

- [ ] **Step 3: Keep the pre-shell App compiling against the new route contract**

In frontend/src/App.tsx replace only the existing AuditView call:

~~~tsx
{view === 'audit' && <AuditView events={d.audit} />}
~~~

- [ ] **Step 4: Run and commit Audit**

Run:

~~~bash
pnpm --dir frontend test -- src/views/AuditView.test.tsx
pnpm --dir frontend build
~~~

Expected: route tests and build pass.

Commit:

~~~bash
git add frontend/src/views/AuditView.tsx frontend/src/views/AuditView.test.tsx frontend/src/App.tsx
git commit -m "feat: preserve and explain audit events"
~~~

---

### Task 12: Persistent Operational Shell, Routing, and Mobile Controls

**Files:**
- Replace: frontend/src/router.ts
- Create: frontend/src/components/shell/WorkspaceTabs.tsx
- Create: frontend/src/components/shell/WorkspaceTabs.test.tsx
- Create: frontend/src/components/shell/MobileControlSheet.tsx
- Create: frontend/src/components/shell/MobileControlSheet.test.tsx
- Create: frontend/src/components/shell/OperationalHeader.tsx
- Create: frontend/src/components/shell/OperationalHeader.test.tsx
- Create: frontend/src/app/AppShell.tsx
- Create: frontend/src/app/AppShell.test.tsx
- Replace: frontend/src/App.tsx
- Replace: frontend/src/ui.tsx
- Delete: frontend/src/views/Overview.tsx
- Delete: frontend/src/views/ThesisView.tsx
- Delete: frontend/src/views/ConfigView.tsx

**Interfaces:**
- Consumes: OperatorController, route components from Tasks 6–11, putConfig(), isMissingKeysError(), ActionControl, StatusMessage, and formatRefreshAge().
- Produces: ROUTES, RouteItem, WorkspaceTabs, BrokerState, OperationalState, MobileControlSheet, OperationalHeader, AppShellView, and AppShell.

- [ ] **Step 1: Replace route metadata while preserving hash behavior**

Replace frontend/src/router.ts:

~~~ts
import { useEffect, useState } from 'react';

export type ViewId = 'overview' | 'thesis' | 'positions' | 'backtest' | 'config' | 'audit';

export interface RouteItem {
  id: ViewId;
  label: 'Monitor' | 'Research' | 'Positions' | 'Backtest' | 'Configuration' | 'Audit';
  mobile: 'primary' | 'more';
}

export const ROUTES: readonly RouteItem[] = [
  { id: 'overview', label: 'Monitor', mobile: 'primary' },
  { id: 'thesis', label: 'Research', mobile: 'primary' },
  { id: 'positions', label: 'Positions', mobile: 'primary' },
  { id: 'backtest', label: 'Backtest', mobile: 'more' },
  { id: 'config', label: 'Configuration', mobile: 'more' },
  { id: 'audit', label: 'Audit', mobile: 'more' },
];

const ids = ROUTES.map((route) => route.id);

function fromHash(): ViewId {
  const value = window.location.hash.replace(/^#\/?/, '') as ViewId;
  return ids.includes(value) ? value : 'overview';
}

export function useHashView(): [ViewId, (view: ViewId) => void] {
  const [view, setView] = useState<ViewId>(fromHash);
  useEffect(() => {
    const onHashChange = () => setView(fromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);
  return [
    view,
    (next) => {
      if (fromHash() === next) {
        setView(next);
      } else {
        window.location.hash = '/' + next;
      }
    },
  ];
}
~~~

- [ ] **Step 2: Write failing route-tab tests**

Create frontend/src/components/shell/WorkspaceTabs.test.tsx:

~~~tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ROUTES } from '../../router';
import { WorkspaceTabs } from './WorkspaceTabs';

describe('WorkspaceTabs', () => {
  it('renders six functional desktop routes and marks the current route', () => {
    render(
      <WorkspaceTabs routes={ROUTES} activeView="overview" onNavigate={vi.fn()} />,
    );
    expect(screen.getByRole('navigation', { name: 'Workspace routes' })).toBeVisible();
    expect(screen.getAllByRole('link', { name: /Monitor|Research|Positions|Backtest|Configuration|Audit/ }))
      .toHaveLength(9);
    expect(screen.getAllByRole('link', { name: 'Monitor' })[0]).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('reaches every secondary route through More and closes after navigation', async () => {
    const onNavigate = vi.fn();
    render(
      <WorkspaceTabs routes={ROUTES} activeView="overview" onNavigate={onNavigate} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'More routes' }));
    const menu = screen.getByRole('menu', { name: 'More routes' });
    expect(menu).toHaveTextContent('Backtest');
    expect(menu).toHaveTextContent('Configuration');
    expect(menu).toHaveTextContent('Audit');
    await userEvent.click(screen.getByRole('menuitem', { name: 'Audit' }));
    expect(onNavigate).toHaveBeenCalledWith('audit');
    expect(screen.queryByRole('menu', { name: 'More routes' })).not.toBeInTheDocument();
  });
});
~~~

The first assertion counts six desktop links plus three mobile-primary links. The More destinations are rendered only while the More menu is open.

Run:

~~~bash
pnpm --dir frontend test -- src/components/shell/WorkspaceTabs.test.tsx
~~~

Expected: FAIL because WorkspaceTabs.tsx does not exist.

- [ ] **Step 3: Implement desktop tabs and mobile primary/More navigation**

Create frontend/src/components/shell/WorkspaceTabs.tsx:

~~~tsx
import { useRef, useState } from 'react';
import type { RouteItem, ViewId } from '../../router';

export interface WorkspaceTabsProps {
  routes: readonly RouteItem[];
  activeView: ViewId;
  onNavigate(view: ViewId): void;
}

export function WorkspaceTabs({
  routes,
  activeView,
  onNavigate,
}: WorkspaceTabsProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  const moreButton = useRef<HTMLButtonElement>(null);
  const secondaryActive = routes.find(
    (route) => route.mobile === 'more' && route.id === activeView,
  );
  const navigate = (view: ViewId) => {
    setMoreOpen(false);
    onNavigate(view);
  };
  return (
    <>
      <nav className="workspace-tabs" aria-label="Workspace routes">
        {routes.map((route) => (
          <a
            key={route.id}
            href={'#/' + route.id}
            aria-current={route.id === activeView ? 'page' : undefined}
            onClick={(event) => {
              event.preventDefault();
              navigate(route.id);
            }}
          >
            {route.label}
          </a>
        ))}
      </nav>
      <nav className="mobile-navigation" aria-label="Mobile workspace routes">
        {routes.filter((route) => route.mobile === 'primary').map((route) => (
          <a
            key={route.id}
            href={'#/' + route.id}
            aria-current={route.id === activeView ? 'page' : undefined}
            onClick={(event) => {
              event.preventDefault();
              navigate(route.id);
            }}
          >
            {route.label}
          </a>
        ))}
        <button
          ref={moreButton}
          type="button"
          aria-label={secondaryActive
            ? 'More routes, current route ' + secondaryActive.label
            : 'More routes'}
          aria-current={secondaryActive ? 'page' : undefined}
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen((open) => !open)}
        >
          More
        </button>
        {moreOpen ? (
          <div className="mobile-navigation__more" role="menu" aria-label="More routes">
            {routes.filter((route) => route.mobile === 'more').map((route) => (
              <button
                key={route.id}
                type="button"
                role="menuitem"
                aria-current={route.id === activeView ? 'page' : undefined}
                onClick={() => navigate(route.id)}
              >
                {route.label}
              </button>
            ))}
          </div>
        ) : null}
      </nav>
    </>
  );
}
~~~

- [ ] **Step 4: Write failing mobile control-sheet focus tests**

Create frontend/src/components/shell/MobileControlSheet.test.tsx:

~~~tsx
import { createRef } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createInitialOperatorState } from '../../app/operatorState';
import { MobileControlSheet } from './MobileControlSheet';

describe('MobileControlSheet', () => {
  it('traps focus, closes on Escape, and returns focus to the trigger', async () => {
    const triggerRef = createRef<HTMLButtonElement>();
    const onClose = vi.fn();
    const state = createInitialOperatorState();
    render(
      <>
        <button ref={triggerRef}>Open controls</button>
        <MobileControlSheet
          open
          triggerRef={triggerRef}
          mode="paper"
          session="closed"
          broker="missing-credentials"
          halted={false}
          refreshText="12s ago"
          actions={state.actions}
          onAction={vi.fn().mockResolvedValue(undefined)}
          onClose={onClose}
        />
      </>,
    );
    expect(screen.getByRole('dialog', { name: 'Trading controls' })).toBeVisible();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus());
    await userEvent.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Halt trading' })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open controls' })).toHaveFocus());
  });
});
~~~

- [ ] **Step 5: Implement the focus-trapped mobile control sheet**

Create frontend/src/components/shell/MobileControlSheet.tsx:

~~~tsx
import {
  useEffect,
  useRef,
  type RefObject,
} from 'react';
import type {
  ActionState,
  OperatorAction,
} from '../../app/operatorState';
import type { Mode, Session } from '../../types';
import { ActionControl } from '../workspace/ActionControl';
import type { BrokerState } from './OperationalHeader';

export interface MobileControlSheetProps {
  open: boolean;
  triggerRef: RefObject<HTMLButtonElement | null>;
  mode: Mode | null;
  session: Session | null;
  broker: BrokerState;
  halted: boolean;
  refreshText: string;
  actions: Record<OperatorAction, ActionState>;
  onAction(action: OperatorAction): Promise<void>;
  onClose(): void;
}

function focusable(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(
    'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled])',
  )];
}

function sessionText(session: Session | null): string {
  if (session === 'premarket') return 'Premarket';
  if (session === 'rth') return 'Regular session';
  if (session === 'afterhours') return 'After-hours';
  if (session === 'closed') return 'Market closed';
  return 'Unknown';
}

function modeText(mode: Mode | null): string {
  if (mode === 'dry-run') return 'Dry run';
  if (mode === 'paper') return 'Paper';
  if (mode === 'live') return 'Live';
  return 'Unknown';
}

function brokerText(broker: BrokerState): string {
  if (broker === 'connected') return 'Connected';
  if (broker === 'missing-credentials') return 'Credentials missing';
  if (broker === 'unavailable') return 'Unavailable';
  return 'Unknown';
}

export function MobileControlSheet({
  open,
  triggerRef,
  mode,
  session,
  broker,
  halted,
  refreshText,
  actions,
  onAction,
  onClose,
}: MobileControlSheetProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) {
      window.setTimeout(() => focusable(panelRef.current!)[0]?.focus(), 0);
    }
  }, [open]);
  if (!open) return null;
  const close = () => {
    onClose();
    window.setTimeout(() => triggerRef.current?.focus(), 0);
  };
  return (
    <div
      className="control-sheet"
      role="dialog"
      aria-modal="true"
      aria-labelledby="control-sheet-title"
      ref={panelRef}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          close();
          return;
        }
        if (event.key !== 'Tab') return;
        const items = focusable(event.currentTarget);
        if (items.length === 0) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
    >
      <div className="control-sheet__surface">
        <header>
          <h2 id="control-sheet-title">Trading controls</h2>
          <button type="button" onClick={close}>Close</button>
        </header>
        <dl className="definition-rows">
          <div><dt>Mode</dt><dd>{modeText(mode)}</dd></div>
          <div><dt>Session</dt><dd>{sessionText(session)}</dd></div>
          <div><dt>Broker</dt><dd>{brokerText(broker)}</dd></div>
          <div><dt>Refresh</dt><dd>{refreshText}</dd></div>
        </dl>
        <div className="control-sheet__actions">
          <ActionControl
            action="analysis"
            label="Run analysis"
            state={actions.analysis}
            onInvoke={onAction}
          />
          <ActionControl
            action="executionCheck"
            label="Check execution now"
            state={actions.executionCheck}
            onInvoke={onAction}
          />
          <ActionControl
            action={halted ? 'resume' : 'halt'}
            label={halted ? 'Resume trading' : 'Halt trading'}
            state={halted ? actions.resume : actions.halt}
            tone={halted ? 'routine' : 'danger'}
            confirmation={halted ? undefined : {
              title: 'Halt trading?',
              body: 'New entries will remain blocked until trading is resumed.',
              confirmLabel: 'Halt trading',
            }}
            onInvoke={onAction}
          />
        </div>
      </div>
    </div>
  );
}
~~~

- [ ] **Step 6: Write failing OperationalHeader tests**

Create frontend/src/components/shell/OperationalHeader.test.tsx:

~~~tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createInitialOperatorState } from '../../app/operatorState';
import { ROUTES } from '../../router';
import { OperationalHeader } from './OperationalHeader';

describe('OperationalHeader', () => {
  it('shows clinical operational state including missing credentials and halt reason', () => {
    const base = createInitialOperatorState();
    render(
      <OperationalHeader
        state={{
          mode: 'paper',
          session: 'closed',
          broker: 'missing-credentials',
          dataFeed: 'iex',
          halt: {
            halted: true,
            reason: 'manual halt',
            at: '2026-07-12T14:00:00.000Z',
          },
          polling: {
            ...base.polling,
            initialLoading: false,
            stale: true,
            lastFullSuccessAt: 1,
          },
        }}
        routes={ROUTES}
        activeView="overview"
        actionStates={base.actions}
        onNavigate={vi.fn()}
        onAction={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    expect(screen.getByText('Broker credentials missing')).toBeVisible();
    expect(screen.getByText(/Halted — manual halt/)).toBeVisible();
    expect(screen.getByText(/Stale/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Resume trading' })).toBeVisible();
  });
});
~~~

- [ ] **Step 7: Implement the persistent operational header**

Create frontend/src/components/shell/OperationalHeader.tsx:

~~~tsx
import { useEffect, useRef, useState } from 'react';
import type {
  ActionState,
  OperatorAction,
  PollingState,
} from '../../app/operatorState';
import type { RouteItem, ViewId } from '../../router';
import type { Config, HaltState, Mode, Session } from '../../types';
import { formatEtTimestamp, formatRefreshAge } from '../../presentation/format';
import { ActionControl } from '../workspace/ActionControl';
import { MobileControlSheet } from './MobileControlSheet';
import { WorkspaceTabs } from './WorkspaceTabs';

export type BrokerState =
  | 'connected'
  | 'missing-credentials'
  | 'unavailable'
  | 'unknown';

export interface OperationalState {
  mode: Mode | null;
  session: Session | null;
  broker: BrokerState;
  dataFeed: Config['data_feed'] | null;
  halt: HaltState | null;
  polling: PollingState;
}

export interface OperationalHeaderProps {
  state: OperationalState;
  routes: readonly RouteItem[];
  activeView: ViewId;
  actionStates: Record<OperatorAction, ActionState>;
  onNavigate(view: ViewId): void;
  onAction(action: OperatorAction): Promise<void>;
}

function brokerText(state: BrokerState): string {
  if (state === 'connected') return 'Broker connected';
  if (state === 'missing-credentials') return 'Broker credentials missing';
  if (state === 'unavailable') return 'Broker unavailable';
  return 'Broker state unknown';
}

function modeText(mode: Mode | null): string {
  if (mode === 'dry-run') return 'Dry run';
  if (mode === 'paper') return 'Paper';
  if (mode === 'live') return 'Live';
  return 'Mode unknown';
}

function sessionText(session: Session | null): string {
  if (session === 'premarket') return 'Premarket';
  if (session === 'rth') return 'Regular session';
  if (session === 'afterhours') return 'After-hours';
  if (session === 'closed') return 'Market closed';
  return 'Session unknown';
}

export function OperationalHeader({
  state,
  routes,
  activeView,
  actionStates,
  onNavigate,
  onAction,
}: OperationalHeaderProps) {
  const [now, setNow] = useState(Date.now());
  const [controlsOpen, setControlsOpen] = useState(false);
  const controlsButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const halted = state.halt?.halted === true;
  const refreshText = formatRefreshAge(state.polling.lastFullSuccessAt, now);
  const etClock = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(now)) + ' ET';

  return (
    <header className="operational-header">
      <div className="operational-header__primary">
        <a className="product-name" href="#/overview" onClick={(event) => {
          event.preventDefault();
          onNavigate('overview');
        }}>
          Offhours
        </a>
        <WorkspaceTabs routes={routes} activeView={activeView} onNavigate={onNavigate} />
        <button
          className="mobile-controls-trigger"
          ref={controlsButton}
          type="button"
          onClick={() => setControlsOpen(true)}
        >
          Controls
        </button>
      </div>
      <div className="operational-header__state" aria-label="Operational state">
        <span>{modeText(state.mode)}</span>
        <span className={state.session === 'closed' ? 'semantic-text--warning' : undefined}>
          {sessionText(state.session)}
        </span>
        <span className={
          state.broker === 'connected'
            ? 'semantic-text--positive'
            : state.broker === 'unavailable'
              ? 'semantic-text--negative'
              : state.broker === 'missing-credentials'
                ? 'semantic-text--warning'
                : undefined
        }>
          {brokerText(state.broker)}
        </span>
        <span>{state.dataFeed ? state.dataFeed.toUpperCase() + ' feed' : 'Feed unknown'}</span>
        <span className={
          state.polling.connectivity === 'offline'
            ? 'semantic-text--negative'
            : state.polling.stale
              ? 'semantic-text--warning'
              : 'semantic-text--positive'
        }>
          {state.polling.connectivity === 'offline'
            ? 'Offline — ' + refreshText
            : state.polling.stale
              ? 'Stale — ' + refreshText
              : 'Updated ' + refreshText}
        </span>
        <span className={halted ? 'semantic-text--negative' : 'semantic-text--positive'}>
          {halted
            ? 'Halted — ' + (state.halt?.reason || 'Reason not recorded') +
              (state.halt?.at ? ', ' + formatEtTimestamp(state.halt.at) : '')
            : 'Risk clear'}
        </span>
        <time>{etClock}</time>
      </div>
      <div className="operational-header__actions">
        <ActionControl
          action="analysis"
          label="Run analysis"
          state={actionStates.analysis}
          onInvoke={onAction}
        />
        <ActionControl
          action="executionCheck"
          label="Check execution now"
          state={actionStates.executionCheck}
          onInvoke={onAction}
        />
        <ActionControl
          action={halted ? 'resume' : 'halt'}
          label={halted ? 'Resume trading' : 'Halt trading'}
          state={halted ? actionStates.resume : actionStates.halt}
          tone={halted ? 'routine' : 'danger'}
          confirmation={halted ? undefined : {
            title: 'Halt trading?',
            body: 'New entries will remain blocked until trading is resumed.',
            confirmLabel: 'Halt trading',
          }}
          onInvoke={onAction}
        />
      </div>
      <MobileControlSheet
        open={controlsOpen}
        triggerRef={controlsButton}
        mode={state.mode}
        session={state.session}
        broker={state.broker}
        halted={halted}
        refreshText={refreshText}
        actions={actionStates}
        onAction={onAction}
        onClose={() => setControlsOpen(false)}
      />
    </header>
  );
}
~~~

- [ ] **Step 8: Write failing AppShell integration tests**

Create frontend/src/app/AppShell.test.tsx:

~~~tsx
import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiResult } from '../api';
import {
  auditFixture,
  backtestFixture,
  candidatesFixture,
  configFixture,
  offhoursPlanFixture,
  ordersFixture,
  positionsFixture,
  rthPlanFixture,
  statusFixture,
  verdictsFixture,
} from '../test/fixtures';
import type { Config } from '../types';
import { createInitialOperatorState, type OperatorState } from './operatorState';
import { AppShellView } from './AppShell';
import type { OperatorController } from './useOperatorController';

const state: OperatorState = {
  ...createInitialOperatorState(),
  data: {
    status: statusFixture,
    candidates: candidatesFixture,
    thesis: offhoursPlanFixture,
    thesisRth: rthPlanFixture,
    verdicts: verdictsFixture,
    positions: positionsFixture,
    orders: ordersFixture,
    audit: auditFixture,
    config: configFixture,
    backtest: backtestFixture,
  },
  polling: {
    ...createInitialOperatorState().polling,
    initialLoading: false,
    connectivity: 'online',
    lastFullSuccessAt: Date.now(),
  },
};

const controller = {
  ...state,
  refresh: vi.fn().mockResolvedValue(undefined),
  runAction: vi.fn().mockResolvedValue(undefined),
} satisfies OperatorController;

describe('AppShellView', () => {
  beforeEach(() => {
    window.location.hash = '#/overview';
  });

  it('renders preserved hashes under the new route labels', () => {
    const save = vi.fn<(next: Config) => Promise<ApiResult<Config>>>()
      .mockResolvedValue({ ok: true, data: configFixture });
    const { rerender } = render(<AppShellView controller={controller} saveConfig={save} />);
    expect(screen.getByRole('table', { name: 'Candidate monitor' })).toBeVisible();

    act(() => {
      window.location.hash = '#/thesis';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    rerender(<AppShellView controller={controller} saveConfig={save} />);
    expect(screen.getByRole('table', { name: 'Research candidates' })).toBeVisible();

    act(() => {
      window.location.hash = '#/audit';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    rerender(<AppShellView controller={controller} saveConfig={save} />);
    expect(screen.getByRole('table', { name: 'Audit events' })).toBeVisible();
  });

  it('keeps action failures visible while navigating', () => {
    const failed = {
      ...controller,
      actions: {
        ...controller.actions,
        executionCheck: {
          phase: 'error' as const,
          message: 'Execution check failed. Broker did not respond. No order was submitted.',
          completedAt: 1,
        },
      },
    };
    render(
      <AppShellView
        controller={failed}
        saveConfig={vi.fn().mockResolvedValue({ ok: true, data: configFixture })}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('No order was submitted.');
    act(() => {
      window.location.hash = '#/positions';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(screen.getByRole('alert')).toHaveTextContent('No order was submitted.');
  });
});
~~~

Run:

~~~bash
pnpm --dir frontend test -- src/components/shell src/app/AppShell.test.tsx
~~~

Expected: shell component tests pass after Steps 3, 5, and 7; AppShell integration fails because AppShell.tsx does not exist.

- [ ] **Step 9: Implement broker derivation and route composition**

Create frontend/src/app/AppShell.tsx:

~~~tsx
import { useCallback, type ReactNode } from 'react';
import { isMissingKeysError, putConfig, type ApiResult } from '../api';
import { OperationalHeader, type BrokerState } from '../components/shell/OperationalHeader';
import { StatusMessage } from '../components/workspace/StatusMessage';
import { formatRefreshAge } from '../presentation/format';
import { ROUTES, useHashView } from '../router';
import type { Config, StatusResponse } from '../types';
import { AuditView } from '../views/AuditView';
import { BacktestView } from '../views/BacktestView';
import { ConfigurationView } from '../views/ConfigurationView';
import { MonitorView } from '../views/MonitorView';
import { PositionsView } from '../views/PositionsView';
import { ResearchView } from '../views/ResearchView';
import type { OperatorController } from './useOperatorController';
import { useOperatorController } from './useOperatorController';

function brokerState(status: StatusResponse | null): BrokerState {
  if (!status) return 'unknown';
  if (status.error && isMissingKeysError(status.error)) return 'missing-credentials';
  if (status.error) return 'unavailable';
  if (status.equity !== null) return 'connected';
  return 'unknown';
}

export interface AppShellViewProps {
  controller: OperatorController;
  saveConfig(next: Config): Promise<ApiResult<Config>>;
}

export function AppShellView({ controller, saveConfig }: AppShellViewProps) {
  const [view, navigate] = useHashView();
  const data = controller.data;
  const activePlan = data.status?.session === 'rth'
    ? data.thesisRth ?? data.thesis
    : data.thesis ?? data.thesisRth;
  let route: ReactNode;
  if (view === 'overview') {
    route = (
      <MonitorView
        status={data.status}
        positions={data.positions}
        candidates={data.candidates}
        verdicts={data.verdicts}
        activePlan={activePlan}
        audit={data.audit}
        config={data.config}
      />
    );
  } else if (view === 'thesis') {
    route = (
      <ResearchView
        candidates={data.candidates}
        verdicts={data.verdicts}
        offhoursPlan={data.thesis}
        rthPlan={data.thesisRth}
        config={data.config}
      />
    );
  } else if (view === 'positions') {
    route = <PositionsView positions={data.positions} orders={data.orders} audit={data.audit} />;
  } else if (view === 'backtest') {
    route = <BacktestView backtest={data.backtest} />;
  } else if (view === 'config') {
    route = <ConfigurationView config={data.config} onSave={saveConfig} />;
  } else {
    route = <AuditView events={data.audit} />;
  }

  const last = formatRefreshAge(controller.polling.lastFullSuccessAt);
  const staleDetail = controller.polling.lastFullSuccessAt === null
    ? 'No full refresh has completed.'
    : 'Showing last-known data from ' + last + '.';
  return (
    <div className="app-shell">
      <OperationalHeader
        state={{
          mode: data.status?.mode ?? data.config?.mode ?? null,
          session: data.status?.session ?? null,
          broker: brokerState(data.status),
          dataFeed: data.config?.data_feed ?? null,
          halt: data.status?.halt ?? null,
          polling: controller.polling,
        }}
        routes={ROUTES}
        activeView={view}
        actionStates={controller.actions}
        onNavigate={navigate}
        onAction={controller.runAction}
      />
      {controller.polling.initialLoading ? (
        <StatusMessage tone="loading" announce="polite">
          Loading operator data.
        </StatusMessage>
      ) : controller.polling.connectivity === 'offline' ? (
        <StatusMessage tone="error" announce="assertive">
          Refresh failed. Data services are unavailable. {staleDetail}
        </StatusMessage>
      ) : controller.polling.stale ? (
        <StatusMessage tone="stale" announce="polite">
          Some data could not be refreshed. {staleDetail}
        </StatusMessage>
      ) : null}
      <div className="app-shell__workspace">{route}</div>
    </div>
  );
}

export function AppShell() {
  const controller = useOperatorController();
  const saveConfig = useCallback(async (next: Config) => {
    const result = await putConfig(next);
    if (result.ok) await controller.refresh();
    return result;
  }, [controller]);
  return <AppShellView controller={controller} saveConfig={saveConfig} />;
}
~~~

Replace frontend/src/App.tsx:

~~~tsx
import { AppShell } from './app/AppShell';

export default function App() {
  return <AppShell />;
}
~~~

Replace frontend/src/ui.tsx with the final compatibility barrel:

~~~ts
export { ActionControl } from './components/workspace/ActionControl';
export { DataTable } from './components/workspace/DataTable';
export type { DataColumn } from './components/workspace/DataTable';
export { MasterDetail } from './components/workspace/MasterDetail';
export { Pane } from './components/workspace/Pane';
export type { PaneTab } from './components/workspace/Pane';
export { ResizableWorkspace } from './components/workspace/ResizableWorkspace';
export { StatusMessage } from './components/workspace/StatusMessage';
~~~

Delete frontend/src/views/Overview.tsx, frontend/src/views/ThesisView.tsx, and frontend/src/views/ConfigView.tsx. AppShell now points at all six replacement routes, so no superseded card-based view remains in the build.

- [ ] **Step 10: Run shell integration and commit**

Run:

~~~bash
pnpm --dir frontend test -- src/components/shell src/app/AppShell.test.tsx
pnpm --dir frontend build
pnpm typecheck
~~~

Expected: shell tests, frontend build, and root typecheck pass. Every old hash still resolves.

Commit:

~~~bash
git add frontend/src/router.ts frontend/src/components/shell frontend/src/app/AppShell.tsx frontend/src/app/AppShell.test.tsx frontend/src/App.tsx frontend/src/ui.tsx frontend/src/views/Overview.tsx frontend/src/views/ThesisView.tsx frontend/src/views/ConfigView.tsx
git commit -m "feat: add persistent operator shell"
~~~

---

### Task 13: Flat Visual System, Responsive Integration, Documentation, and Final QA

**Files:**
- Create: frontend/src/components/workspace/SemanticText.tsx
- Modify: frontend/src/ui.tsx
- Modify: frontend/src/views/MonitorView.tsx
- Modify: frontend/src/views/PositionsView.tsx
- Modify: frontend/src/views/BacktestView.tsx
- Modify: frontend/src/views/AuditView.tsx
- Replace: frontend/src/styles.css
- Replace: frontend/index.html
- Replace: DESIGN.md

**Interfaces:**
- Consumes: all shell, primitive, and route class names established by Tasks 4–12.
- Produces: SemanticText and the final edge-to-edge terminal at wide, compact, and mobile tiers.

- [ ] **Step 1: Add a text-backed semantic-color primitive**

Create frontend/src/components/workspace/SemanticText.tsx:

~~~tsx
import type { ReactNode } from 'react';

export type SemanticTone =
  | 'positive'
  | 'negative'
  | 'warning'
  | 'selection'
  | 'neutral';

export function SemanticText({
  tone,
  children,
}: {
  tone: SemanticTone;
  children: ReactNode;
}) {
  return <span className={'semantic-text semantic-text--' + tone}>{children}</span>;
}
~~~

Add this line to frontend/src/ui.tsx:

~~~ts
export { SemanticText } from './components/workspace/SemanticText';
~~~

Use SemanticText around, but never instead of, the visible text in these exact cells:

~~~tsx
// MonitorView.tsx candidate columns
{
  id: 'position',
  header: 'Panel position',
  cell: (row) => (
    <SemanticText
      tone={row.panelPosition === 'long'
        ? 'positive'
        : row.panelPosition === 'short'
          ? 'negative'
          : 'neutral'}
    >
      {directionText(row.panelPosition)}
    </SemanticText>
  ),
}
{
  id: 'outcome',
  header: 'Outcome',
  cell: (row) => (
    <SemanticText
      tone={row.outcome === 'selected'
        ? 'positive'
        : row.outcome === 'pending'
          ? 'warning'
          : 'neutral'}
    >
      {row.outcomeText}
    </SemanticText>
  ),
}

// PositionsView.tsx open gain/loss cell
{
  id: 'pnl',
  header: 'Open gain/loss',
  cell: (row) => (
    <SemanticText tone={row.unrealizedPl >= 0 ? 'positive' : 'negative'}>
      {(row.unrealizedPl >= 0 ? '+' : '') + formatUsd(row.unrealizedPl)}
    </SemanticText>
  ),
  align: 'right',
}

// BacktestView.tsx sweep P&L cell
cell: (row) => (
  <SemanticText tone={row.netPnlUsd >= 0 ? 'positive' : 'negative'}>
    {(row.netPnlUsd >= 0 ? '+' : '') + formatUsd(row.netPnlUsd)}
  </SemanticText>
)

// BacktestView.tsx trade-log P&L cell
cell: (row) => (
  <SemanticText tone={row.pnlUsd >= 0 ? 'positive' : 'negative'}>
    {(row.pnlUsd >= 0 ? '+' : '') + formatUsd(row.pnlUsd)}
  </SemanticText>
)

// AuditView.tsx status cell
cell: (row) => (
  <SemanticText
    tone={row.status === 'completed'
      ? 'positive'
      : row.status === 'failed' || row.status === 'rejected'
        ? 'negative'
        : row.status === 'pending' || row.status === 'skipped' || row.status === 'halted'
          ? 'warning'
          : 'neutral'}
  >
    {sentenceCase(row.status)}
  </SemanticText>
)
~~~

Import SemanticText in each changed route. Keep selection blue confined to row-selection CSS.

- [ ] **Step 2: Replace the complete stylesheet**

Replace frontend/src/styles.css with:

~~~css
:root {
  color-scheme: dark;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 14px;
  font-synthesis: none;
  --canvas: #0b0d0e;
  --pane: #111416;
  --raised: #181d20;
  --separator: #2a3034;
  --text: #eef1f2;
  --secondary: #8e979d;
  --selection: #5b9bd5;
  --positive: #65ba8c;
  --negative: #d96666;
  --warning: #d2a653;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

* {
  box-sizing: border-box;
}

html,
body,
#root {
  width: 100%;
  min-width: 0;
  height: 100%;
  margin: 0;
}

body {
  min-width: 320px;
  overflow: hidden;
  background: var(--canvas);
  color: var(--text);
  font-size: 13px;
  line-height: 1.4;
}

button,
input,
select {
  font: inherit;
}

button,
select,
input {
  border: 1px solid var(--separator);
  border-radius: 2px;
  background: var(--pane);
  color: var(--text);
}

button {
  min-height: 32px;
  padding: 5px 10px;
  cursor: pointer;
}

button:hover:not(:disabled),
select:hover,
input:hover {
  border-color: var(--secondary);
}

button:disabled {
  cursor: not-allowed;
  color: var(--secondary);
  opacity: 0.62;
}

:focus-visible {
  outline: 2px solid var(--selection);
  outline-offset: -2px;
}

a {
  color: inherit;
  text-decoration: none;
}

h1,
h2,
h3,
p,
dl,
dd,
figure {
  margin: 0;
}

h2 {
  font-size: 13px;
  font-weight: 600;
}

h3 {
  font-size: 12px;
  font-weight: 600;
}

ul {
  margin: 6px 0 0;
  padding-left: 18px;
}

pre {
  max-width: 100%;
  margin: 0;
  overflow: auto;
  color: var(--secondary);
  font: 11px/1.5 var(--mono);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.app-shell {
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr);
  width: 100%;
  height: 100dvh;
  overflow: hidden;
  background: var(--canvas);
}

.app-shell > .status-message {
  border-right: 0;
  border-left: 0;
}

.app-shell__workspace,
.route {
  min-width: 0;
  min-height: 0;
  height: 100%;
  overflow: hidden;
}

.operational-header {
  z-index: 20;
  display: grid;
  grid-template-areas:
    "primary actions"
    "state state";
  grid-template-columns: minmax(0, 1fr) auto;
  border-bottom: 1px solid var(--separator);
  background: var(--pane);
}

.operational-header__primary {
  grid-area: primary;
  display: flex;
  min-width: 0;
  height: 42px;
  align-items: stretch;
}

.product-name {
  display: grid;
  min-width: 118px;
  padding: 0 14px;
  place-items: center start;
  border-right: 1px solid var(--separator);
  font-weight: 650;
}

.workspace-tabs {
  display: flex;
  min-width: 0;
  overflow-x: auto;
}

.workspace-tabs a {
  display: grid;
  min-width: max-content;
  padding: 0 12px;
  place-items: center;
  border-right: 1px solid var(--separator);
  border-bottom: 2px solid transparent;
  color: var(--secondary);
}

.workspace-tabs a[aria-current="page"] {
  color: var(--text);
  border-bottom-color: var(--selection);
  background: var(--raised);
}

.operational-header__state {
  grid-area: state;
  display: flex;
  min-width: 0;
  min-height: 28px;
  align-items: center;
  overflow-x: auto;
  border-top: 1px solid var(--separator);
  color: var(--secondary);
  font: 11px var(--mono);
}

.operational-header__state > span,
.operational-header__state > time {
  flex: 0 0 auto;
  padding: 0 10px;
  border-right: 1px solid var(--separator);
  white-space: nowrap;
}

.operational-header__actions {
  grid-area: actions;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  border-left: 1px solid var(--separator);
}

.operational-header__actions .action-control {
  position: relative;
}

.operational-header__actions > .action-control:last-child {
  margin-left: 4px;
  padding-left: 10px;
  border-left: 1px solid var(--separator);
}

.operational-header__actions .action-control__result {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  width: 320px;
  border: 1px solid var(--separator);
  background: var(--raised);
}

.mobile-controls-trigger,
.mobile-navigation {
  display: none;
}

.pane {
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr);
  min-width: 0;
  min-height: 0;
  height: 100%;
  border-right: 1px solid var(--separator);
  border-bottom: 1px solid var(--separator);
  background: var(--pane);
}

.pane__header {
  display: flex;
  min-height: 36px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 10px;
  border-bottom: 1px solid var(--separator);
  background: var(--raised);
}

.pane__heading {
  display: flex;
  min-width: 0;
  align-items: baseline;
  gap: 8px;
}

.pane__subtitle,
.pane__toolbar {
  color: var(--secondary);
  font-size: 11px;
}

.pane__toolbar {
  min-width: 0;
}

.pane__tabs {
  display: flex;
  min-height: 34px;
  overflow-x: auto;
  border-bottom: 1px solid var(--separator);
}

.pane__tabs button {
  min-width: max-content;
  border-width: 0 1px 2px 0;
  border-right-color: var(--separator);
  border-bottom-color: transparent;
  border-radius: 0;
  color: var(--secondary);
}

.pane__tabs button[aria-selected="true"] {
  color: var(--text);
  background: var(--raised);
  border-bottom-color: var(--selection);
}

.pane__body {
  min-width: 0;
  min-height: 0;
  overflow: auto;
}

.data-table-wrap {
  max-width: 100%;
  min-width: 0;
  overflow: auto;
}

.data-table {
  width: 100%;
  min-width: 100%;
  border-collapse: collapse;
  table-layout: auto;
}

.data-table th,
.data-table td {
  height: 36px;
  padding: 0 9px;
  border-bottom: 1px solid var(--separator);
  text-align: left;
  vertical-align: middle;
}

.data-table th {
  position: sticky;
  top: 0;
  z-index: 2;
  background: var(--pane);
  color: var(--secondary);
  font-size: 11px;
  font-weight: 500;
  white-space: nowrap;
}

.data-table td {
  max-width: 460px;
}

.data-table .is-numeric {
  text-align: right;
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
}

.data-table tbody > tr:not(.data-table__expanded):hover {
  background: var(--raised);
}

.data-table tbody > tr[tabindex] {
  cursor: pointer;
}

.data-table tbody > tr.is-selected {
  background: var(--raised);
  border-left: 3px solid var(--selection);
}

.data-table__empty td {
  height: 56px;
  color: var(--secondary);
}

.data-table__expanded td {
  height: auto;
  padding: 12px;
  background: var(--raised);
}

.status-message {
  min-height: 34px;
  padding: 8px 10px;
  border: 1px solid var(--separator);
  color: var(--secondary);
  background: var(--pane);
}

.status-message--success {
  border-left-color: var(--positive);
  color: var(--positive);
}

.status-message--error {
  border-left-color: var(--negative);
  color: var(--negative);
}

.status-message--warning,
.status-message--stale,
.status-message--loading {
  border-left-color: var(--warning);
  color: var(--warning);
}

.semantic-text {
  color: var(--secondary);
}

.semantic-text--positive {
  color: var(--positive);
}

.semantic-text--negative {
  color: var(--negative);
}

.semantic-text--warning {
  color: var(--warning);
}

.semantic-text--selection {
  color: var(--selection);
}

.action-control > button {
  white-space: nowrap;
}

.action-control--danger > button,
button.is-danger {
  border-color: var(--negative);
  color: var(--negative);
}

button.is-primary {
  border-color: var(--selection);
  color: var(--text);
}

.action-control__result {
  margin-top: 6px;
  padding: 8px;
  color: var(--secondary);
}

.action-control__result.is-success {
  color: var(--positive);
}

.action-control__result.is-error {
  color: var(--negative);
}

.confirmation,
.control-sheet {
  position: fixed;
  z-index: 100;
  inset: 0;
  display: grid;
  background: rgba(11, 13, 14, 0.86);
}

.confirmation {
  place-items: center;
}

.confirmation__surface {
  width: min(420px, calc(100vw - 32px));
  border: 1px solid var(--separator);
  border-radius: 2px;
  padding: 16px;
  background: var(--pane);
}

.confirmation__surface p {
  margin-top: 8px;
  color: var(--secondary);
}

.confirmation__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}

.resizable-workspace {
  display: grid;
  grid-template-columns:
    var(--left-width)
    1px
    minmax(480px, 1fr)
    1px
    var(--right-width);
  grid-template-rows: minmax(300px, 1fr) minmax(180px, 34vh);
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
}

.resizable-workspace__left {
  grid-column: 1;
  grid-row: 1 / 3;
  min-width: 0;
  min-height: 0;
}

.resizable-workspace__center {
  grid-column: 3;
  grid-row: 1;
  min-width: 0;
  min-height: 0;
}

.resizable-workspace__right {
  grid-column: 5;
  grid-row: 1;
  min-width: 0;
  min-height: 0;
}

.resizable-workspace__bottom {
  grid-column: 3 / 6;
  grid-row: 2;
  min-width: 0;
  min-height: 0;
}

.resizable-workspace__separator {
  position: relative;
  z-index: 5;
  grid-row: 1 / 3;
  width: 1px;
  background: var(--separator);
  cursor: col-resize;
  touch-action: none;
}

.resizable-workspace__separator::after {
  position: absolute;
  inset: 0 -6px;
  content: "";
}

.resizable-workspace__separator.is-left {
  grid-column: 2;
}

.resizable-workspace__separator.is-right {
  grid-column: 4;
}

.resizable-workspace[data-layout="wide"]
  .resizable-workspace__center
  .master-detail__detail {
  display: none;
}

.monitor-sidebar {
  display: grid;
  grid-template-rows: minmax(220px, 0.8fr) minmax(280px, 1.2fr);
  height: 100%;
}

.master-detail {
  display: grid;
  grid-template-columns: minmax(360px, 1.15fr) minmax(300px, 0.85fr);
  min-width: 0;
  min-height: 0;
  height: 100%;
}

.master-detail__master,
.master-detail__detail {
  min-width: 0;
  min-height: 0;
  height: 100%;
}

.master-detail__back {
  display: none;
}

.definition-rows {
  display: grid;
}

.definition-rows > div {
  display: grid;
  grid-template-columns: minmax(110px, 1fr) minmax(0, 1.2fr);
  min-height: 36px;
  align-items: center;
  gap: 12px;
  padding: 5px 10px;
  border-bottom: 1px solid var(--separator);
}

.definition-rows dt {
  color: var(--secondary);
}

.definition-rows dd {
  min-width: 0;
  overflow-wrap: anywhere;
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
}

.detail-stack {
  display: grid;
  gap: 14px;
  padding: 12px;
}

.evidence-group {
  display: grid;
  gap: 4px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--separator);
}

.raw-detail,
.audit-detail {
  display: grid;
  gap: 12px;
}

.configuration {
  width: min(1180px, 100%);
  margin: 0 auto;
}

.config-readonly {
  border-bottom: 1px solid var(--separator);
}

.config-readonly > p {
  padding: 10px;
  color: var(--secondary);
}

.config-group {
  display: grid;
  grid-template-columns: 190px minmax(0, 1fr);
  border-bottom: 1px solid var(--separator);
}

.config-group > h3 {
  padding: 12px 10px;
  color: var(--secondary);
}

.config-fields {
  display: grid;
  grid-template-columns: repeat(3, minmax(170px, 1fr));
  border-left: 1px solid var(--separator);
}

.field,
.check-field {
  display: grid;
  min-width: 0;
  min-height: 64px;
  align-content: center;
  gap: 5px;
  padding: 8px 10px;
  border-right: 1px solid var(--separator);
  border-bottom: 1px solid var(--separator);
}

.field > span,
.check-field > span,
.table-filters label > span {
  color: var(--secondary);
  font-size: 11px;
}

.field input,
.field select,
.table-filters select {
  min-width: 0;
  height: 32px;
  padding: 4px 7px;
  font-family: var(--mono);
}

.field--wide {
  grid-column: 1 / -1;
}

.check-field {
  grid-template-columns: auto 1fr;
  align-items: center;
  align-content: center;
}

.exclude-list,
.field-inline,
.configuration__actions,
.table-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
}

.exclude-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 5px;
  border: 1px solid var(--separator);
  font-family: var(--mono);
}

.exclude-item button {
  min-height: 24px;
  padding: 2px 4px;
  border: 0;
  color: var(--secondary);
  font-size: 11px;
}

.configuration__actions {
  position: sticky;
  bottom: 0;
  justify-content: flex-end;
  padding: 10px;
  border-top: 1px solid var(--separator);
  background: var(--pane);
}

.table-filters {
  align-items: end;
}

.table-filters label {
  display: grid;
  gap: 3px;
}

.backtest-chart {
  display: grid;
  gap: 8px;
  padding: 12px;
}

.backtest-chart svg {
  width: 100%;
  max-height: 420px;
  border: 1px solid var(--separator);
  background: var(--canvas);
}

.chart-zero {
  stroke: var(--separator);
  stroke-width: 1;
}

.chart-line {
  fill: none;
  stroke: var(--secondary);
  stroke-width: 1.5;
}

.backtest-chart circle {
  fill: var(--pane);
  stroke: var(--text);
}

.backtest-chart figcaption {
  color: var(--secondary);
  font-size: 11px;
}

.resizable-workspace--compact {
  display: grid;
  grid-template-columns: minmax(480px, 1fr) minmax(300px, 0.72fr);
  grid-template-rows: auto minmax(420px, 1fr) minmax(180px, 34vh);
  overflow: auto;
}

.resizable-workspace--compact .resizable-workspace__left,
.resizable-workspace--compact .resizable-workspace__bottom {
  grid-column: 1 / 3;
  grid-row: auto;
}

.resizable-workspace--compact .resizable-workspace__center {
  grid-column: 1;
  grid-row: 2;
}

.resizable-workspace--compact .resizable-workspace__right {
  display: block;
  grid-column: 2;
  grid-row: 2;
}

.resizable-workspace__back {
  display: none;
}

.resizable-workspace--compact .monitor-sidebar {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  grid-template-rows: minmax(220px, auto);
  height: auto;
}

@media (max-width: 899px) {
  body {
    overflow: hidden;
  }

  .app-shell {
    grid-template-rows: auto auto minmax(0, 1fr);
    padding-bottom: 54px;
  }

  .operational-header {
    display: block;
  }

  .operational-header__primary {
    height: 44px;
    justify-content: space-between;
  }

  .product-name {
    min-width: auto;
  }

  .workspace-tabs,
  .operational-header__actions {
    display: none;
  }

  .mobile-controls-trigger {
    display: block;
    min-width: 88px;
    min-height: 44px;
    border-width: 0 0 0 1px;
    border-radius: 0;
  }

  .operational-header__state {
    min-height: 34px;
  }

  .operational-header__state > span,
  .operational-header__state > time {
    min-height: 34px;
    display: grid;
    place-items: center;
  }

  .operational-header__state > span:nth-child(4),
  .operational-header__state > time {
    display: none;
  }

  .mobile-navigation {
    position: fixed;
    z-index: 50;
    right: 0;
    bottom: 0;
    left: 0;
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    height: 54px;
    border-top: 1px solid var(--separator);
    background: var(--pane);
  }

  .mobile-navigation > a,
  .mobile-navigation > button {
    display: grid;
    min-width: 0;
    min-height: 44px;
    padding: 0 4px;
    place-items: center;
    border-width: 0 1px 0 0;
    border-radius: 0;
    color: var(--secondary);
  }

  .mobile-navigation > a[aria-current="page"],
  .mobile-navigation > button[aria-current="page"] {
    color: var(--text);
    border-top: 2px solid var(--selection);
  }

  .mobile-navigation__more {
    position: fixed;
    right: 8px;
    bottom: 62px;
    display: grid;
    width: min(260px, calc(100vw - 16px));
    border: 1px solid var(--separator);
    background: var(--pane);
  }

  .mobile-navigation__more button {
    min-height: 44px;
    border-width: 0 0 1px;
    border-radius: 0;
    text-align: left;
  }

  .control-sheet {
    align-items: end;
  }

  .control-sheet__surface {
    max-height: calc(100dvh - 20px);
    overflow: auto;
    border: 1px solid var(--separator);
    border-bottom: 0;
    background: var(--pane);
  }

  .control-sheet__surface > header {
    display: flex;
    min-height: 48px;
    align-items: center;
    justify-content: space-between;
    padding: 0 10px;
    border-bottom: 1px solid var(--separator);
  }

  .control-sheet__actions {
    display: grid;
    gap: 8px;
    padding: 10px;
  }

  .control-sheet__actions > .action-control:last-child {
    margin-top: 4px;
    padding-top: 12px;
    border-top: 1px solid var(--separator);
  }

  .control-sheet__actions button {
    width: 100%;
    min-height: 44px;
  }

  .app-shell__workspace {
    overflow: auto;
  }

  .route {
    height: auto;
    min-height: 100%;
    overflow: visible;
  }

  .resizable-workspace--compact {
    display: block;
    overflow: visible;
  }

  .resizable-workspace--compact .resizable-workspace__right {
    display: none;
  }

  .resizable-workspace--compact[data-detail-open="true"] .resizable-workspace__center {
    display: none;
  }

  .resizable-workspace--compact[data-detail-open="true"] .resizable-workspace__right {
    display: block;
  }

  .resizable-workspace__back {
    display: block;
    width: 100%;
    min-height: 44px;
    border-width: 0 0 1px;
    border-radius: 0;
    text-align: left;
  }

  .resizable-workspace--compact .monitor-sidebar {
    display: block;
  }

  .pane {
    height: auto;
    min-height: 180px;
    border-right: 0;
  }

  .pane__body {
    overflow: visible;
  }

  .master-detail {
    display: block;
    height: auto;
  }

  .master-detail__detail {
    display: none;
  }

  .master-detail[data-detail-open="true"] .master-detail__master {
    display: none;
  }

  .master-detail[data-detail-open="true"] .master-detail__detail {
    display: block;
  }

  .master-detail__back {
    display: block;
    width: 100%;
    min-height: 44px;
    border-width: 0 0 1px;
    border-radius: 0;
    text-align: left;
  }

  .data-table th,
  .data-table td {
    height: 44px;
  }

  .data-table [data-mobile-priority="secondary"] {
    display: none;
  }

  .definition-rows > div {
    min-height: 44px;
  }

  .config-group {
    display: block;
  }

  .config-fields {
    grid-template-columns: minmax(0, 1fr);
    border-left: 0;
  }

  .field,
  .check-field {
    min-height: 70px;
    border-right: 0;
  }

  .field input,
  .field select,
  .field-inline button,
  .configuration__actions button,
  .table-filters select {
    min-height: 44px;
  }

  .table-filters {
    display: grid;
    padding: 6px 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    scroll-behavior: auto !important;
    transition-duration: 0.01ms !important;
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
  }
}
~~~

Run this static scan:

~~~bash
rg -n "gradient|box-shadow:|border-radius: ([5-9]|[1-9][0-9])|animation:" frontend/src/styles.css
~~~

Expected: no output; the stylesheet contains no gradient, shadow, large radius, or animation declaration.

- [ ] **Step 3: Remove external fonts and rename the document**

Replace frontend/index.html:

~~~html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="color-scheme" content="dark" />
    <meta name="theme-color" content="#0b0d0e" />
    <title>Offhours — Operator terminal</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
~~~

Keep frontend/src/main.tsx unchanged.

- [ ] **Step 4: Replace the obsolete design source of truth**

Replace DESIGN.md:

~~~md
# Offhours UI design

The approved source of truth for the current interface is
[Operator Terminal UI Redesign](docs/superpowers/specs/2026-07-12-operator-terminal-ui-redesign-design.md).

The executable task sequence is
[Operator Terminal UI Redesign Implementation Plan](docs/superpowers/plans/2026-07-12-operator-terminal-ui-redesign.md).

The previous Instrument language, external typefaces, cards, gradients, ambient
graphics, entrance animation, and pulsing status treatment are retired.
~~~

- [ ] **Step 5: Run the complete automated suite**

Run:

~~~bash
pnpm --dir frontend test
pnpm --dir frontend build
pnpm typecheck
pnpm test
~~~

Expected:

- all frontend component, state, route, and integration tests pass;
- frontend TypeScript and Vite build pass;
- root TypeScript passes;
- the 579 existing backend tests plus every new frontend test pass.

Do not reduce, skip, or rewrite existing backend tests to obtain green output.

- [ ] **Step 6: Start the seeded application for read-only browser QA**

Terminal A:

~~~bash
if [ -n "$(find out -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]; then
  echo "Using the existing out/ dataset; seed skipped."
else
  pnpm seed
fi
pnpm --dir frontend build
pnpm serve
~~~

Expected: the server listens on http://127.0.0.1:4310 and serves the built frontend.
The command never overwrites an existing out/ dataset. Complete state-matrix coverage comes from the fixed typed component fixtures; real-browser QA validates layout and interaction against whichever read-only local dataset is already present.

Do not invoke Run analysis, Check execution now, Halt trading, Resume trading, or Save configuration during browser QA. Their success, failure, confirmation, and draft paths are covered by injected component tests so QA cannot mutate a configured brokerage environment or strategy file.

- [ ] **Step 7: Verify every route and required viewport**

Terminal B:

~~~bash
B="$HOME/.agents/skills/gstack/browse/dist/browse"
$B goto http://127.0.0.1:4310/#/overview

$B viewport 1440x900
$B screenshot /tmp/operator-1440x900.png --viewport
$B js "document.documentElement.scrollWidth <= document.documentElement.clientWidth"
$B console --errors

$B viewport 1024x768
$B screenshot /tmp/operator-1024x768.png --viewport
$B js "document.documentElement.scrollWidth <= document.documentElement.clientWidth"
$B console --errors

$B viewport 768x1024
$B screenshot /tmp/operator-768x1024.png --viewport
$B js "document.documentElement.scrollWidth <= document.documentElement.clientWidth"
$B console --errors

$B viewport 390x844
$B screenshot /tmp/operator-390x844.png --viewport
$B js "document.documentElement.scrollWidth <= document.documentElement.clientWidth"
$B console --errors
~~~

Expected at every viewport: overflow expression returns true; console reports no errors; screenshots show flat edge-to-edge panes, no cards, no clipped controls, no decorative effects.

Navigate all preserved hashes and capture an interaction snapshot:

~~~bash
$B goto http://127.0.0.1:4310/#/overview
$B snapshot -i
$B goto http://127.0.0.1:4310/#/thesis
$B snapshot -i
$B goto http://127.0.0.1:4310/#/positions
$B snapshot -i
$B goto http://127.0.0.1:4310/#/backtest
$B snapshot -i
$B goto http://127.0.0.1:4310/#/config
$B snapshot -i
$B goto http://127.0.0.1:4310/#/audit
$B snapshot -i
$B accessibility
$B js "document.documentElement.style.filter='grayscale(1)'"
$B screenshot /tmp/operator-grayscale.png --viewport
$B js "document.documentElement.style.filter=''"
~~~

Expected: all six routes render; every route tab has one current state; named tables use column headers; pane tabs expose tab semantics; no accessibility output reports missing names for interactive controls. The grayscale screenshot still communicates positive, negative, stale, halted, selected, and rejected states through visible words, signs, borders, or current-state semantics.

- [ ] **Step 8: Verify resizing, linked selection, mobile navigation, and focus**

At 1440x900:

1. Focus both vertical separators in the interaction snapshot.
2. Press ArrowLeft and ArrowRight; confirm aria-valuenow changes in 10 px increments and center remains at least 480 px.
3. Reload; confirm stored values persist.
4. Double-click each separator; confirm defaults return and localStorage key offhours.monitor.columns.v1 is removed.
5. Select WBD; confirm adjacent detail changes immediately and states Not recorded for skipped confidence.

At 1024x768:

1. Confirm all three Monitor columns remain visible.
2. Confirm left is at least 220 px, right at least 300 px, and center at least 480 px.
3. Confirm both resize handles remain keyboard accessible.

At 768x1024 and 390x844:

1. Confirm no separator exists.
2. Confirm the bottom bar contains Monitor, Research, Positions, and More.
3. Use More to reach Backtest, Configuration, and Audit.
4. Open Controls, Tab through every focusable item, Shift+Tab from the first item, press Escape, and confirm focus returns to Controls.
5. Select a candidate and confirm the in-route detail replaces the list; Back to candidates restores it.
6. Confirm all buttons, inputs, selects, and table rows measure at least 44 px high.

Expected: every interaction matches the behavior above; body width never exceeds viewport width.

- [ ] **Step 9: Exercise hidden-state fixtures in component tests**

Run these focused cases after the browser pass:

~~~bash
pnpm --dir frontend test -- \
  src/app/operatorState.test.ts \
  src/app/useOperatorController.test.tsx \
  src/components/workspace/ActionControl.test.tsx \
  src/views/ConfigurationView.test.tsx \
  src/views/MonitorView.test.tsx \
  src/views/AuditView.test.tsx
~~~

Expected: offline, partial stale, recovery, missing-key copy, halted state, empty plan/data, action error, config save error, unknown audit, and no-order-confirmation assertions all pass.

- [ ] **Step 10: Review the visual result against the approved bans**

Inspect the four screenshots side by side and reject the implementation if any of these are present:

- floating or repeated KPI cards;
- pill-shaped status treatments or decorative dots;
- gradients, glows, glass, ambient grid, vignette, or decorative shadow;
- promotional or heroic copy;
- a chart not backed by backtest cells;
- a value inferred from absent API data;
- decorative font loading;
- entrance or perpetual motion;
- more than seven default candidate columns;
- selection blue used for long, short, gain, loss, or rejection.

Expected: none are present. If spacing or contrast needs tuning, change only the palette variables, row padding, or separator contrast, then repeat Steps 5–8.

- [ ] **Step 11: Commit the completed redesign**

~~~bash
git add frontend/src frontend/index.html DESIGN.md frontend/package.json package.json pnpm-lock.yaml
git commit -m "feat: redesign dashboard as operator terminal"
~~~

Final expected git status: only the user's pre-existing .gitignore, .superpowers, docs/HOW-IT-WORKS.md, and docs/HOW-IT-WORKS.pdf changes remain outside the redesign commits.
