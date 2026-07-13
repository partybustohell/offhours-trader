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
import {
  SemanticText,
  type SemanticTone,
} from '../components/workspace/SemanticText';
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
  now?: number;
}

function keyOfCandidate(row: CandidateDecisionRow): string {
  return row.symbol;
}

function directionText(direction: Direction): string {
  if (direction === 'long') return 'Long';
  if (direction === 'short') return 'Short';
  return 'No position';
}

function directionTone(direction: Direction): SemanticTone {
  if (direction === 'long') return 'positive';
  if (direction === 'short') return 'negative';
  return 'neutral';
}

function activityStatusTone(
  status: PresentedAuditEvent['status'],
): SemanticTone {
  if (status === 'completed') return 'positive';
  if (status === 'failed' || status === 'rejected') return 'negative';
  if (status === 'pending' || status === 'skipped' || status === 'halted') {
    return 'warning';
  }
  return 'neutral';
}

interface AccountRow {
  label: string;
  value: string;
  tone: SemanticTone | null;
}

function accountRows(
  status: StatusResponse | null,
  positions: PositionsResponse,
  config: Config | null,
): AccountRow[] {
  const marketValuesRecorded = positions.positions.every((position) =>
    Number.isFinite(position.marketValue),
  );
  const pnlValuesRecorded = positions.positions.every((position) =>
    Number.isFinite(position.unrealizedPl),
  );
  const exposure = marketValuesRecorded
    ? positions.positions.reduce(
        (total, position) => total + Math.abs(position.marketValue),
        0,
      )
    : null;
  const pnl = pnlValuesRecorded
    ? positions.positions.reduce(
        (total, position) => total + position.unrealizedPl,
        0,
      )
    : null;
  const brokerDataAvailable = !positions.error;
  const halt = status?.halt;
  return [
    { label: 'Account value', value: formatUsd(status?.equity), tone: null },
    {
      label: 'Open exposure',
      value: brokerDataAvailable && exposure !== null
        ? formatUsd(exposure)
        : 'Not available',
      tone: null,
    },
    {
      label: 'Open positions',
      value: brokerDataAvailable
        ? String(positions.positions.length)
        : 'Not available',
      tone: null,
    },
    {
      label: 'Open gain/loss',
      value: !brokerDataAvailable || pnl === null
        ? 'Not available'
        : pnl > 0
          ? '+' + formatUsd(pnl)
          : formatUsd(pnl),
      tone: !brokerDataAvailable || pnl === null || pnl === 0
        ? 'neutral'
        : pnl > 0
          ? 'positive'
          : 'negative',
    },
    {
      label: 'Daily deployment used',
      value: 'Not available from current API',
      tone: null,
    },
    {
      label: 'Daily deployment limit',
      value: formatPercent(config?.max_daily_deploy_pct),
      tone: null,
    },
    {
      label: 'Risk halt',
      value: halt == null
        ? 'Not available'
        : halt.halted
          ? 'Halted — ' + (halt.reason || 'Reason not recorded')
          : 'Clear',
      tone: halt == null
        ? 'neutral'
        : halt.halted
          ? 'negative'
          : 'positive',
    },
  ];
}

function orderedAuditEvents(events: readonly AuditEvent[]) {
  return events
    .map((event, index) => ({
      event,
      index,
      timestamp: Date.parse(event.ts),
    }))
    .sort((a, b) => {
      const aRecorded = Number.isFinite(a.timestamp);
      const bRecorded = Number.isFinite(b.timestamp);
      if (aRecorded && bRecorded) {
        return b.timestamp - a.timestamp || a.index - b.index;
      }
      if (aRecorded) return -1;
      if (bRecorded) return 1;
      return a.index - b.index;
    });
}

function latestEvent(events: readonly AuditEvent[], kinds: readonly string[]): AuditEvent | null {
  const matching = events.filter((event) => kinds.includes(event.kind));
  return orderedAuditEvents(matching)[0]?.event ?? null;
}

function planState(plan: Thesis | null, now: number): string {
  if (!plan) return 'No trading plan is available.';
  const expiry = Date.parse(plan.expiresAt);
  if (!Number.isFinite(expiry)) return 'Trading plan expiry was not recorded.';
  if (expiry <= now) {
    return 'The latest trading plan expired at ' + formatEtTimestamp(plan.expiresAt) + '.';
  }
  return String(plan.entries.length) + ' selected, ' + String(plan.skipped.length) + ' not selected.';
}

function AccountPane(props: Pick<MonitorViewProps, 'status' | 'positions' | 'config'>) {
  return (
    <Pane id="account-state" title="Account">
      <dl className="definition-rows">
        {accountRows(props.status, props.positions, props.config).map((row) => (
          <div key={row.label}>
            <dt>{row.label}</dt>
            <dd>
              {row.tone ? (
                <SemanticText tone={row.tone}>{row.value}</SemanticText>
              ) : row.value}
            </dd>
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

type AutomationPaneProps = Pick<
  MonitorViewProps,
  'status' | 'activePlan' | 'audit'
> & { now: number };

function AutomationPane(props: AutomationPaneProps) {
  const analysis = latestEvent(props.audit, ['thesis', 'candidates']);
  const execution = latestEvent(props.audit, ['tick']);
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
          <dd>{planState(props.activePlan, props.now)}</dd>
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
          <dd>Not available from current API</dd>
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
            <div>
              <dt>Panel position</dt>
              <dd>
                <SemanticText tone={directionTone(row.panelPosition)}>
                  {directionText(row.panelPosition)}
                </SemanticText>
              </dd>
            </div>
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
                cell: (item) => (
                  <SemanticText tone={item.view ? directionTone(item.view.direction) : 'neutral'}>
                    {item.view ? directionText(item.view.direction) : 'Not recorded'}
                  </SemanticText>
                ),
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
    () => orderedAuditEvents(audit)
      .slice(0, 20)
      .map(({ event, index }) => presentAuditEvent(event, index)),
    [audit],
  );
  const columns: DataColumn<PresentedAuditEvent>[] = [
    { id: 'time', header: 'Time (ET)', cell: (row) => row.timestamp },
    { id: 'activity', header: 'Activity', cell: (row) => row.activity },
    { id: 'stage', header: 'Stage', cell: (row) => row.stage, mobilePriority: 'secondary' },
    {
      id: 'status',
      header: 'Status',
      cell: (row) => (
        <SemanticText tone={activityStatusTone(row.status)}>
          {sentenceCase(row.status)}
        </SemanticText>
      ),
    },
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
            <dl className="definition-rows">
              <div><dt>Raw kind</dt><dd>{row.rawKind}</dd></div>
            </dl>
            <pre>{row.rawJson}</pre>
          </div>
        )}
      />
    </Pane>
  );
}

export function MonitorView(props: MonitorViewProps) {
  const now = props.now ?? Date.now();
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
      cell: (row) => (
        <SemanticText tone={directionTone(row.panelPosition)}>
          {directionText(row.panelPosition)}
        </SemanticText>
      ),
    },
    {
      id: 'agreement',
      header: 'Agreement',
      cell: (row) => String(row.agreeing) + ' / ' + (row.requiredAgreeing ?? 'Not recorded'),
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
    },
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
  const detail = (
    <CandidateDetail
      key={selection.selectedKey ?? 'no-candidate'}
      row={selection.selectedItem}
      plan={props.activePlan}
    />
  );

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
              now={now}
            />
          </div>
        )}
        center={master}
        right={detail}
        bottom={<ActivityBlotter audit={props.audit} />}
        detailOpen={selection.detailOpen}
        detailLabel="Candidate detail"
        backLabel="Back to candidates"
        onDetailClose={selection.closeDetail}
      />
    </main>
  );
}
