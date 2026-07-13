import { useMemo, useState } from 'react';
import { DataTable, type DataColumn } from '../components/workspace/DataTable';
import { MasterDetail } from '../components/workspace/MasterDetail';
import { Pane } from '../components/workspace/Pane';
import {
  SemanticText,
  type SemanticTone,
} from '../components/workspace/SemanticText';
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

interface FilteredResearchSymbol extends ResearchSymbol {
  reason: string;
}

interface PlanResearchSymbol extends ResearchSymbol {
  outcome: 'Selected' | 'Not selected';
}

function symbolKey(item: ResearchSymbol): string {
  return item.symbol;
}

function directionText(value: Direction): string {
  return value === 'long' ? 'Long' : value === 'short' ? 'Short' : 'No position';
}

function directionTone(value: Direction): SemanticTone {
  if (value === 'long') return 'positive';
  if (value === 'short') return 'negative';
  return 'neutral';
}

function recordedDirection(value: Direction | null) {
  return (
    <SemanticText tone={value ? directionTone(value) : 'neutral'}>
      {value ? directionText(value) : 'Not recorded'}
    </SemanticText>
  );
}

function recordedText(value: string): string {
  return value.trim() || 'Not recorded';
}

function requiredAnalystCount(config: Config | null): string {
  return config && Number.isFinite(config.min_agreeing)
    ? String(config.min_agreeing)
    : 'Not recorded';
}

function recordedDate(value: string | undefined): string | null {
  const date = value?.trim();
  return date ? date : null;
}

function matchesDecisionDate(value: string | undefined, decisionDate: string | null): boolean {
  return decisionDate !== null && recordedDate(value) === decisionDate;
}

function planForKind(plan: Thesis | null, kind: Thesis['kind']): Thesis | null {
  return plan?.kind === kind ? plan : null;
}

function planRows(plan: Thesis | null): PlanResearchSymbol[] {
  const rows = new Map<string, PlanResearchSymbol>();
  plan?.entries.forEach((item) => {
    rows.set(item.ticker, { symbol: item.ticker, outcome: 'Selected' });
  });
  plan?.skipped.forEach((item) => {
    if (!rows.has(item.ticker)) {
      rows.set(item.ticker, { symbol: item.ticker, outcome: 'Not selected' });
    }
  });
  return [...rows.values()];
}

export function ResearchView({
  candidates,
  verdicts,
  offhoursPlan,
  rthPlan,
  config,
}: ResearchViewProps) {
  const [tab, setTab] = useState('candidates');
  const offhoursSource = planForKind(offhoursPlan, 'offhours');
  const rthSource = planForKind(rthPlan, 'rth');
  const symbols = useMemo(() => {
    const values = new Set<string>();
    if (tab === 'candidates') {
      candidates?.candidates.forEach((item) => values.add(item.ticker));
    } else if (tab === 'filtered') {
      candidates?.rejected.forEach((item) => values.add(item.ticker));
    } else {
      const plan = tab === 'rth' ? rthSource : offhoursSource;
      plan?.entries.forEach((item) => values.add(item.ticker));
      plan?.skipped.forEach((item) => values.add(item.ticker));
    }
    return [...values].sort().map((symbol) => ({ symbol }));
  }, [candidates, offhoursSource, rthSource, tab]);
  const selection = useLinkedSelection(symbols, symbolKey);
  const selected = selection.selectedItem?.symbol ?? null;

  const candidateRows = candidates?.candidates ?? [];
  const filteredRows = candidates?.rejected.map((item) => ({
    symbol: item.ticker,
    reason: item.reason,
  })) ?? [];
  const offhoursRows = planRows(offhoursSource);
  const rthRows = planRows(rthSource);
  const planColumns: DataColumn<PlanResearchSymbol>[] = [
    { id: 'symbol', header: 'Symbol', cell: (row) => row.symbol },
    {
      id: 'outcome',
      header: 'Outcome',
      cell: (row) => (
        <SemanticText tone={row.outcome === 'Selected' ? 'positive' : 'neutral'}>
          {row.outcome}
        </SemanticText>
      ),
    },
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
              cell: (row) =>
                row.nominatedBy.map((item) => sentenceCase(item.analyst)).join(', ') ||
                'Not recorded',
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
        <DataTable<FilteredResearchSymbol>
          ariaLabel="Filtered-out symbols"
          rows={filteredRows}
          columns={[
            { id: 'symbol', header: 'Symbol', cell: (row) => row.symbol },
            { id: 'reason', header: 'Rule', cell: (row) => recordedText(row.reason) },
          ]}
          rowKey={(row) => row.symbol}
          rowLabel={(row) => 'Inspect ' + row.symbol + ' research'}
          selectedKey={selection.selectedKey}
          onSelect={selectSymbol}
          emptyMessage="No symbols were filtered out."
        />
      ) : null}
      {tab === 'offhours' ? (
        <DataTable<PlanResearchSymbol>
          ariaLabel="Off-hours trading plan"
          rows={offhoursRows}
          columns={planColumns}
          rowKey={symbolKey}
          rowLabel={(row) => 'Inspect ' + row.symbol + ' research'}
          selectedKey={selection.selectedKey}
          onSelect={selectSymbol}
          emptyMessage="No off-hours plan symbols were recorded."
        />
      ) : null}
      {tab === 'rth' ? (
        <DataTable<PlanResearchSymbol>
          ariaLabel="Regular-session trading plan"
          rows={rthRows}
          columns={planColumns}
          rowKey={symbolKey}
          rowLabel={(row) => 'Inspect ' + row.symbol + ' research'}
          selectedKey={selection.selectedKey}
          onSelect={selectSymbol}
          emptyMessage="No regular-session plan symbols were recorded."
        />
      ) : null}
    </Pane>
  );

  const selectedPlan = tab === 'rth'
    ? rthSource
    : tab === 'offhours'
      ? offhoursSource
      : null;
  const decisionDate = tab === 'candidates' || tab === 'filtered'
    ? recordedDate(candidates?.date)
    : recordedDate(selectedPlan?.date);
  const compatibleCandidates = matchesDecisionDate(candidates?.date, decisionDate)
    ? candidates
    : null;
  const compatibleVerdicts = matchesDecisionDate(verdicts?.date, decisionDate)
    ? verdicts
    : null;
  const selectedViews = compatibleVerdicts?.verdicts.filter(
    (item) => item.ticker === selected,
  ) ?? [];
  const selectedCandidate = tab === 'filtered'
    ? null
    : (tab === 'candidates' ? candidates : compatibleCandidates)
      ?.candidates.find((item) => item.ticker === selected) ?? null;
  const selectedRejection = tab === 'filtered'
    ? candidates?.rejected.find((item) => item.ticker === selected) ?? null
    : null;
  const selectedEntry =
    selectedPlan?.entries.find((item) => item.ticker === selected) ?? null;
  const skipped =
    selectedPlan?.skipped.find((item) => item.ticker === selected) ?? null;
  const invalidationConditions = selectedEntry?.invalidationConditions
    .map((item) => item.trim())
    .filter((item) => item.length > 0) ?? [];

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
              {selectedCandidate.nominatedBy.length ? (
                <ul>
                  {selectedCandidate.nominatedBy.map((item) => (
                    <li key={item.analyst + ':' + item.reason}>
                      {sentenceCase(item.analyst)} — {recordedText(item.reason)}
                    </li>
                  ))}
                </ul>
              ) : <p>Not recorded</p>}
            </section>
          ) : null}
          {selectedEntry ? (
            <>
              <p>{recordedText(selectedEntry.narrative)}</p>
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
                <div>
                  <dt>Position</dt>
                  <dd>{recordedDirection(selectedEntry.direction)}</dd>
                </div>
                <div>
                  <dt>Required analyst count</dt>
                  <dd>{requiredAnalystCount(config)}</dd>
                </div>
                <div><dt>Confidence</dt><dd>{formatPercent(selectedEntry.weightedConviction)}</dd></div>
                <div>
                  <dt>Limit band</dt>
                  <dd>{formatUsd(selectedEntry.limitBand.low)}–{formatUsd(selectedEntry.limitBand.high)}</dd>
                </div>
                <div><dt>Target notional</dt><dd>{formatUsd(selectedEntry.targetNotionalUsd)}</dd></div>
              </dl>
            </>
          ) : tab === 'filtered' ? (
            <>
              <p>
                {selectedRejection
                  ? 'Filtered out — ' + recordedText(selectedRejection.reason)
                  : 'No filtered-out record for ' + selected + ' in this candidate file.'}
              </p>
              <dl className="definition-rows">
                <div><dt>Source</dt><dd>Filtered out</dd></div>
              </dl>
            </>
          ) : tab === 'candidates' ? (
            <>
              <p>Trading-plan outcomes are shown in the session plan tabs.</p>
              <dl className="definition-rows">
                <div><dt>Source</dt><dd>Candidate selection</dd></div>
                <div>
                  <dt>Required analyst count</dt>
                  <dd>{requiredAnalystCount(config)}</dd>
                </div>
                <div><dt>Confidence</dt><dd>Not recorded</dd></div>
              </dl>
            </>
          ) : (
            <>
              <p>
                No trading-plan entry for {selected}.{' '}
                {skipped ? recordedText(skipped.reason) : 'A reason was not recorded.'}
              </p>
              <dl className="definition-rows">
                <div>
                  <dt>Trading plan</dt>
                  <dd>{tab === 'rth' ? 'Regular session' : 'Off-hours'}</dd>
                </div>
                <div>
                  <dt>Required analyst count</dt>
                  <dd>{requiredAnalystCount(config)}</dd>
                </div>
                <div><dt>Confidence</dt><dd>Not recorded</dd></div>
              </dl>
            </>
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
                cell: (row) => recordedDirection(row.view?.direction ?? null),
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
                cell: (row) =>
                  row.view?.evidence.filter((item) => item.trim()).join(' ') || 'Not recorded',
                mobilePriority: 'secondary',
              },
            ]}
            rowKey={(row) => row.analyst}
            emptyMessage="No analyst views were recorded."
          />
          <section>
            <h3>Invalidation conditions</h3>
            {invalidationConditions.length ? (
              <ul>
                {invalidationConditions.map((item, index) => (
                  <li key={String(index) + ':' + item}>{item}</li>
                ))}
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
        backLabel={
          tab === 'filtered'
            ? 'Back to filtered out'
            : tab === 'offhours'
              ? 'Back to off-hours plan'
              : tab === 'rth'
                ? 'Back to regular-session plan'
                : 'Back to candidates'
        }
        onDetailClose={selection.closeDetail}
      />
    </main>
  );
}
