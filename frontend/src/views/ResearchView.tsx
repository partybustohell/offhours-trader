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

interface FilteredResearchSymbol extends ResearchSymbol {
  reason: string;
}

function symbolKey(item: ResearchSymbol): string {
  return item.symbol;
}

function direction(direction: Direction): string {
  return direction === 'long' ? 'Long' : direction === 'short' ? 'Short' : 'No position';
}

function recordedText(value: string): string {
  return value.trim() || 'Not recorded';
}

function requiredAnalystCount(config: Config | null): string {
  return config && Number.isFinite(config.min_agreeing)
    ? String(config.min_agreeing)
    : 'Not recorded';
}

export function ResearchView({
  candidates,
  verdicts,
  offhoursPlan,
  rthPlan,
  config,
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
                <div><dt>Position</dt><dd>{direction(selectedEntry.direction)}</dd></div>
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
          ) : (
            <>
              <p>
                No trading-plan entry for {selected}.{' '}
                {skipped ? recordedText(skipped.reason) : 'A reason was not recorded.'}
              </p>
              <dl className="definition-rows">
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
