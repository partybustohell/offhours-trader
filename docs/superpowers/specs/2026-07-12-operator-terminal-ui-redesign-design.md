# Off-Hours Trader — Operator Terminal UI Redesign

Date: 2026-07-12  
Status: Approved for implementation

## Objective

Replace the current “Instrument” dashboard with a desktop-first operator terminal
that is credible as trading software and readable without professional terminal
experience.

The redesign must preserve the behavior and safety boundaries of the current
application. It changes the presentation and interaction model, not the trading
system.

## Product posture

The dashboard is a local control and observability surface for one owner/operator.
It is not a retail brokerage, a marketing page, or a manual order-entry system.
Its primary jobs are:

1. Show account, session, connection, automation, and risk state.
2. Explain which candidates were reviewed and why each did or did not become a
   trading-plan entry.
3. Show positions, orders, and deterministic risk rejections.
4. Run analysis or an execution check, and halt or resume trading.
5. Inspect backtest evidence, configuration, and the audit record.

The interface must treat “no trade” as a normal, explicit outcome.

## Design constraint

Use the functional grammar of a modern consumer-readable trading terminal:

- edge-to-edge application workspace;
- functional top-level tabs;
- persistent account, market, broker, data, synchronization, and halt state;
- linked panes in which selecting a row updates the adjacent detail pane;
- resizable desktop columns;
- monitor tables as the primary information surface;
- a chronological activity blotter;
- progressive disclosure for evidence and advanced detail;
- plain, clinical language.

Do not add a visual theme on top of the product. Specifically:

- no hero statements or promotional copy;
- no floating KPI cards;
- no decorative pills, status dots, glows, gradients, glass effects, or ambient
  background graphics;
- no large radii or shadows;
- no ornamental charts or invented market data;
- no bespoke icon system when a text label is clearer;
- no gamification, celebration, or motivational language.

Panels are structural regions, not cards. A border, title bar, tab strip, or
resize divider must communicate function.

## Research basis

The terminal structure is grounded in:

- Interactive Brokers TWS Mosaic: linked panels, monitor tables, activity area,
  and persistent trading state.
- Bloomberg Launchpad: persistent context, linked worksheets, table-first
  monitoring, and semantic color.
- Trading Technologies Desktop: resizable widget workspaces, connection state,
  and order/fill/audit tables.
- Robinhood Legend: modernized linked and resizable desktop widgets without
  legacy terminal chrome.

The readable layer is grounded in:

- Robinhood: strict reading order, familiar labels, safe defaults, and advanced
  capability revealed on demand.
- Public: one clear account hierarchy, ordinary portfolio terms, thin dividers,
  and deliberate review states.
- Lightyear: Basic/Advanced disclosure, explicit transaction outcomes, and
  explanations placed beside the value they qualify.

These are interaction references, not branding references. The implementation
must not copy product marks, proprietary imagery, or marketing treatments.

## Information architecture

Keep the existing hash routes so old links remain valid. Change visible labels
where clarity improves:

| Existing route | Visible label | Purpose |
| --- | --- | --- |
| `overview` | Monitor | Current operating state and latest decisions |
| `thesis` | Research | Candidates, analyst views, and current plans |
| `positions` | Positions | Positions, orders, and risk rejections |
| `backtest` | Backtest | Historical evidence and trade log |
| `config` | Configuration | Existing editable strategy and risk settings |
| `audit` | Audit | Human-readable and raw event record |

No global symbol search is added. The application only exposes symbols already
present in its candidates, plans, positions, orders, or audit data.

## Application shell

### Global header

The header remains visible on every route and contains:

- product name;
- functional route tabs;
- account mode, written as `Paper`, `Dry run`, or `Live`;
- market session;
- broker connection state;
- data feed;
- last successful refresh age;
- halt state;
- ET clock;
- `Run analysis`, `Check execution now`, and `Halt trading` or
  `Resume trading` actions.

Action labels describe the user-visible result. Internal terms such as
`pipeline` and `tick` do not appear as primary labels.

The halt action remains separated from routine actions and requires confirmation.
When halted, the header shows the halt reason and time rather than only the word
`Halted`.

### Desktop workspace

At widths of 900 px and above, Monitor uses three columns plus a bottom activity
area:

1. Account and automation state.
2. Dominant candidate monitor table.
3. Detail for the selected candidate.
4. Activity blotter below the monitor and detail columns.

Two visible vertical dividers resize the left and right columns. Widths are
stored in `localStorage` and reset by double-clicking a divider. The left column
is constrained to 220–360 px, the right column to 300–480 px, and the center
column never shrinks below 480 px. Arbitrary drag-and-drop docking is out of
scope.

Selecting a candidate row updates the detail pane immediately. If the selected
symbol disappears after a refresh, selection moves to the first available row.
If no rows exist, the detail pane states that there is no candidate to inspect.

Other routes use the same pane and table primitives but do not need resizable
columns unless they contain a master-detail layout.

### Mobile workspace

Below 900 px:

- route navigation becomes a persistent bottom bar with `Monitor`, `Research`,
  `Positions`, and `More`;
- persistent operational state is reduced to mode, session, connection, halt,
  and refresh age;
- routine and dangerous actions move into a clearly labeled control sheet;
- panes become a single reading column;
- selecting a table row opens the detail as an in-route screen or sheet;
- resize handles are removed;
- essential table columns remain visible and secondary columns move into row
  detail;
- controls use at least 44 px touch targets;
- the page body never scrolls horizontally.

## Monitor route

### Account pane

Show one account value with supporting rows:

- open exposure;
- open positions;
- open gain/loss when available;
- daily deployment used and limit;
- risk halt state.

Do not split these values into independent cards.

### Automation pane

Show the latest analysis state, current-plan state, last execution check, and
next execution check. Routine actions may be repeated here, but must use the same
labels as the global header.

When the market is closed, state the consequence directly:

> The market is closed. An execution check will be recorded without submitting
> an order.

### Candidate monitor

This is the dominant surface. Default columns are:

- Symbol
- Panel position
- Agreement
- Confidence
- Outcome

Supplementary nomination and filtering data is available through a secondary
tab or the detail pane. The default view must not expose more than seven columns.

Example outcome copy:

> Not selected — 1 of 2 required analysts agreed.

`None` becomes `No position`. `Conviction` is presented as `Confidence`, with an
inline definition available. Raw values remain accessible in details.

### Candidate detail

Tabs are `Summary`, `Evidence`, and `Rules`.

Summary states:

- decision;
- causal reason;
- observed agreement and required agreement;
- observed confidence and required confidence;
- each analyst's position and confidence.

Example:

> No entry for WBD. One of two required analysts supported a long position.
> Four analysts took no position. The agreement requirement was not met.

Evidence contains the existing analyst evidence. Rules contains invalidation
conditions and any available sizing or regime attribution. No absent field is
invented.

### Activity blotter

Default columns are:

- Time (ET)
- Activity
- Stage
- Status
- What happened

Newest events appear first. Internal event data is converted into a clinical
sentence, with raw JSON available on demand.

Example:

> Execution check skipped. The market session is closed. No order was evaluated.

## Research route

Research provides deeper inspection without duplicating the Monitor route:

- current off-hours and regular-session plans;
- candidate and filtered-out tables;
- five-analyst position matrix;
- narrative, evidence, invalidation, limit band, confidence, and notional for a
  selected plan entry;
- skipped candidates and the exact rule that excluded them.

Use a master-detail layout. Selection is shared within the route so candidate,
analyst, and plan details stay synchronized.

## Positions route

Use tabs for `Positions`, `Orders`, and `Risk rejections` rather than three
vertically stacked cards.

Tables remain the primary surface. Selecting a row opens detail with full status,
timestamps, price fields, and rejection reasons. Present broker status in plain
language while retaining the raw status in detail.

Empty-state examples:

- `No open positions.`
- `No orders were submitted today.`
- `No orders were rejected by the risk checks today.`

## Backtest route

Retain the existing P&L-by-threshold chart, sweep table, and trade log, but place
them in a flat analytical workspace with tabs or panes.

Remove hard-coded dates, episode counts, capital, and statistical conclusions
that are not returned by the API. Show only the available backtest tag, cells,
trades, and calculated values. No edge or profitability claim may be inferred
from styling.

## Configuration route

Expose the configuration fields already supported by the current frontend and
API. Do not claim that the view contains every backend setting.

Group fields under `Universe`, `Sessions and data`, `Analyst weights`, `Decision
rules`, `Risk limits`, `Execution`, and `Models`. Each group is a flat form
section with short descriptions where needed.

The mode and live-trading acknowledgment remain read-only. Explain that both
must be changed in `config.yaml`.

A ten-second data refresh must not overwrite an in-progress edit. The form keeps
its local draft while dirty, shows that newer server data exists, and lets the
user choose to discard or save the draft. Save success and failure appear in a
screen-reader-announced status region.

## Audit route

Use a table with filters for activity type and status. Default cells show parsed,
human-readable descriptions. Expanding a row reveals timestamp, event kind,
structured fields, and raw JSON.

Unknown event kinds remain visible and are labeled `Unknown event` rather than
being normalized to another event type.

## Visual system

### Typography

- UI: native system sans stack (`-apple-system`, `BlinkMacSystemFont`,
  `Segoe UI`, sans-serif).
- Numeric data: native monospace stack (`ui-monospace`, `SFMono-Regular`,
  `Menlo`, `Consolas`, monospace).
- Default UI text: 13–14 px.
- Default table rows: 36 px on desktop.
- No interface text below 11 px.
- Numbers use tabular figures and right alignment.

### Surfaces

- neutral near-black application canvas;
- one slightly lighter pane surface;
- one title-bar or selected-row surface;
- one-pixel separators;
- zero to 4 px corner radius;
- no decorative shadows.

Exact values may be tuned during visual QA, but the initial semantic palette is:

- canvas: `#0b0d0e`;
- pane: `#111416`;
- raised or selected surface: `#181d20`;
- separator: `#2a3034`;
- primary text: `#eef1f2`;
- secondary text: `#8e979d`;
- selection and linked context: `#5b9bd5`;
- positive, long, completed, or healthy: `#65ba8c`;
- negative, short, rejected, or dangerous: `#d96666`;
- pending, blocked, stale, or market closed: `#d2a653`.

Color always appears with text, a sign, or another non-color cue. Selection blue
is never reused for financial direction.

### Motion

No entrance choreography or perpetual animation. Use only short state
transitions for selection, panel resizing, disclosure, and action feedback.
Respect `prefers-reduced-motion`.

## Language rules

- Use sentence case.
- Prefer ordinary terms, with technical terms secondary when necessary.
- State what happened, why it happened, and what the system will do next.
- Include units and timestamps.
- Do not apologize, celebrate, or speculate.
- Do not call an empty state an insight.

Term mapping:

| Internal term | Primary UI term |
| --- | --- |
| Pipeline | Analysis |
| Tick | Execution check |
| Thesis | Trading plan |
| Verdict | Analyst view |
| None | No position |
| Conviction | Confidence |
| Quorum | Required analyst count |
| Risk gate | Risk checks |

## Component boundaries

The React structure uses small, role-specific components:

- `AppShell`: route selection, persistent header, desktop/mobile navigation, and
  global action feedback.
- `OperationalHeader`: mode, session, broker, data, refresh, halt, clock, and
  global actions.
- `WorkspaceTabs`: route tabs and mobile `More` navigation.
- `Pane`: structural title bar, optional tab strip, overflow behavior, and
  accessible label.
- `ResizableWorkspace`: constrained desktop column sizing, keyboard resize, and
  persistence.
- `DataTable`: shared table shell, empty row, row selection, numeric alignment,
  and contained horizontal overflow when necessary.
- `MasterDetail`: selection state and synchronization between a table and its
  detail pane.
- `StatusMessage`: clinical loading, stale, empty, success, warning, and error
  messages with live-region support.
- `ActionControl`: pending state, confirmation where required, and visible API
  result.
- Route components: `MonitorView`, `ResearchView`, `PositionsView`,
  `BacktestView`, `ConfigurationView`, and `AuditView`.

Each component accepts domain data and callbacks through explicit props. Shared
components do not fetch. `AppShell` owns polling and mutations; route components
derive only view-specific selection and draft state. This keeps API behavior
separate from presentation and prevents pane components from silently changing
trading state.

## Data and state flow

Keep the current API endpoints and ten-second polling interval. No backend trading
logic changes are part of this redesign.

The UI must surface states that are currently hidden:

- initial loading;
- online, offline, and stale data;
- last successful refresh;
- missing broker credentials;
- action in progress, success, and failure;
- clear and halted risk state, including reason and time;
- missing, empty, active, and expired plans;
- flat and open-position states;
- absent and available backtest data;
- clean, dirty, saving, saved, and failed configuration drafts.

`Promise.allSettled` may continue preserving last-known good data, but stale data
must be labeled. Action failures must not be discarded.

## Accessibility

- Every route tab exposes `aria-current`.
- Detail tabs expose tab roles and selected state.
- Expanding rows expose `aria-expanded`.
- Action and save results use live regions.
- Keyboard focus is always visible.
- Resize dividers are keyboard adjustable and expose separator semantics.
- Tables use real headers and accessible names.
- Status never relies on color alone.
- The mobile control sheet traps focus and returns it to its trigger.

## Error handling

Errors use a consistent structure:

> [Operation] failed. [Known cause]. [Available next action].

Examples:

- `Refresh failed. Broker data is unavailable. Showing data from 11:42:08 ET.`
- `Configuration was not saved. Confidence must be between 0 and 1. Review the
  highlighted field.`
- `Order submission could not be confirmed. Check broker activity before retrying.`

The interface must never imply that an order was placed when the response is
unknown.

## Implementation boundaries

In scope:

- complete React component and CSS restructuring;
- visible-label and copy changes;
- linked selection and desktop resize behavior;
- mobile navigation and responsive layouts;
- accessibility semantics;
- hidden-state and action-error surfacing;
- configuration draft protection;
- removal of unsupported hard-coded backtest copy.

Out of scope:

- trading logic or risk-rule changes;
- broker or API changes;
- manual order entry;
- arbitrary ticker search;
- new market-data or chart endpoints;
- arbitrary widget docking or multi-monitor support;
- authentication;
- changes to live-mode activation requirements.

## Verification

Automated checks:

- `pnpm --dir frontend build`;
- `pnpm typecheck`;
- `pnpm test`.

Manual browser checks at 1440×900, 1024×768, 768×1024, and 390×844:

- every route renders with seeded data;
- no horizontal body overflow;
- desktop dividers resize within constraints and persist;
- mobile navigation reaches every route;
- candidate selection updates detail;
- keyboard navigation and focus order are complete;
- color-disabled review still communicates every state;
- offline, stale, missing-key, halted, empty-plan, active-plan, action-error, and
  config-save-error states are legible;
- reduced-motion preference is respected.

## Acceptance criteria

The redesign is complete when:

1. The application reads as one coherent operator workspace, not a collection of
   dashboard cards.
2. A non-professional can determine account state, automation state, current
   plan, and the reason for each excluded candidate without reading raw JSON.
3. Every existing route and mutation remains functional.
4. Dangerous actions remain explicit, separated, and confirmed.
5. Desktop panes link and resize as specified.
6. Mobile has complete navigation and no clipped status or controls.
7. Hidden failures and stale data are surfaced.
8. No unsupported market data, statistics, or trading outcomes are invented.
