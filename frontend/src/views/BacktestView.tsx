import { useId, useState } from 'react';
import { DataTable } from '../components/workspace/DataTable';
import { Pane } from '../components/workspace/Pane';
import { StatusMessage } from '../components/workspace/StatusMessage';
import { buildBacktestPoints } from '../presentation/backtest';
import {
  formatEtTimestamp,
  formatPercent,
  formatUsd,
  sentenceCase,
} from '../presentation/format';
import type { BacktestResponse, BacktestTrade } from '../types';

export interface BacktestViewProps {
  backtest: BacktestResponse | null;
}

interface IndexedTrade {
  trade: BacktestTrade;
  sourceIndex: number;
}

function recordedText(value: string | null | undefined): string {
  const text = value?.trim();
  return text ? text : 'Not recorded';
}

function formattedPnl(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? '+' + formatUsd(value)
    : formatUsd(value);
}

function pnlText(value: number | null | undefined) {
  const recorded = typeof value === 'number' && Number.isFinite(value);
  const className = !recorded || value === 0
    ? undefined
    : value > 0
      ? 'semantic-text--positive'
      : 'semantic-text--negative';
  return <span className={className}>{formattedPnl(value)}</span>;
}

function formatBearWeight(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? value.toFixed(1)
    : 'Not recorded';
}

function chartPointLabel(point: ReturnType<typeof buildBacktestPoints>[number]) {
  return [
    'Cell ' + recordedText(point.key),
    'Confidence ' + formatPercent(point.threshold),
    'Bear weight ' + formatBearWeight(point.bearWeight),
    'Net P&L ' + formattedPnl(point.pnl),
  ].join('; ');
}

function PnlChart({ backtest }: { backtest: BacktestResponse }) {
  const pointListId = useId();
  const points = buildBacktestPoints(backtest.cells ?? []);
  if (points.length === 0) {
    return (
      <StatusMessage tone="empty">
        No threshold cells were returned.
      </StatusMessage>
    );
  }

  const width = 720;
  const height = 260;
  const padding = 32;
  const pnls = points.map((point) => point.pnl);
  const minPnl = Math.min(0, ...pnls);
  const maxPnl = Math.max(0, ...pnls);
  const pnlRange = Math.max(1, maxPnl - minPnl);
  const thresholds = points.map((point) => point.threshold);
  const minThreshold = Math.min(...thresholds);
  const maxThreshold = Math.max(...thresholds);
  const thresholdRange = maxThreshold - minThreshold;
  const coordinates = points.map((point) => {
    const x = thresholdRange === 0
      ? width / 2
      : padding +
        ((point.threshold - minThreshold) / thresholdRange) *
          (width - padding * 2);
    const y =
      height -
      padding -
      ((point.pnl - minPnl) / pnlRange) * (height - padding * 2);
    return { ...point, x, y };
  });
  const zeroY =
    height -
    padding -
    ((0 - minPnl) / pnlRange) * (height - padding * 2);

  return (
    <figure className="backtest-chart">
      <svg
        viewBox={'0 0 ' + width + ' ' + height}
        role="img"
        aria-label="Net P&L by confidence threshold"
      >
        <line
          x1={padding}
          x2={width - padding}
          y1={zeroY}
          y2={zeroY}
          className="chart-zero"
        />
        {coordinates.map((point, index) => (
          <circle
            key={point.key + ':' + index}
            cx={point.x}
            cy={point.y}
            r="3"
            tabIndex={0}
            aria-label={chartPointLabel(point)}
            aria-describedby={pointListId + '-point-' + index}
          >
            <title>
              {formatPercent(point.threshold) + ': ' + formatUsd(point.pnl)}
            </title>
          </circle>
        ))}
      </svg>
      <figcaption>
        Net P&amp;L returned for each confidence threshold. Points are unconnected
        because other sweep parameters may differ.
      </figcaption>
      <ul className="backtest-point-list" aria-label="Backtest chart point values">
        {coordinates.map((point, index) => (
          <li id={pointListId + '-point-' + index} key={point.key + ':' + index}>
            <span>Cell {recordedText(point.key)}</span>
            <span>Confidence {formatPercent(point.threshold)}</span>
            <span>Bear weight {formatBearWeight(point.bearWeight)}</span>
            <span>Net P&amp;L {pnlText(point.pnl)}</span>
          </li>
        ))}
      </ul>
    </figure>
  );
}

export function BacktestView({ backtest }: BacktestViewProps) {
  const [tab, setTab] = useState('pnl');

  if (!backtest?.available) {
    return (
      <main className="route route--backtest">
        <Pane id="backtest" title="Backtest">
          <StatusMessage tone="empty">
            No backtest result is available.
          </StatusMessage>
        </Pane>
      </main>
    );
  }

  const tradeRows: IndexedTrade[] = (backtest.trades ?? []).map(
    (trade, sourceIndex) => ({ trade, sourceIndex }),
  );

  return (
    <main className="route route--backtest">
      <Pane
        id="backtest"
        title="Backtest"
        subtitle={recordedText(backtest.tag)}
        toolbar={
          backtest.generatedAt ? (
            <span>Generated {formatEtTimestamp(backtest.generatedAt)}</span>
          ) : null
        }
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
              {
                id: 'cell',
                header: 'Cell',
                cell: (row) => recordedText(row.cell),
              },
              {
                id: 'threshold',
                header: 'Confidence threshold',
                cell: (row) => formatPercent(row.threshold),
                align: 'right',
              },
              {
                id: 'bear-weight',
                header: 'Bear weight',
                cell: (row) => formatBearWeight(row.bearWeight ?? row.bear),
                align: 'right',
              },
              {
                id: 'abstained',
                header: 'Abstained',
                cell: (row) => row.abstained,
                align: 'right',
              },
              {
                id: 'placed',
                header: 'Orders placed',
                cell: (row) => row.ordersPlaced,
                align: 'right',
              },
              {
                id: 'filled',
                header: 'Orders filled',
                cell: (row) => row.ordersFilled,
                align: 'right',
              },
              {
                id: 'trades',
                header: 'Trades',
                cell: (row) => row.trades,
                align: 'right',
              },
              {
                id: 'pnl',
                header: 'Net P&L',
                cell: (row) => pnlText(row.netPnlUsd),
                align: 'right',
              },
            ]}
            rowKey={(row) => row.cell}
            emptyMessage="No threshold cells were returned."
          />
        ) : null}
        {tab === 'trades' ? (
          <div className="detail-stack">
            <p>Trade-log cell: {recordedText(backtest.tradeLogCell)}</p>
            <DataTable
              ariaLabel="Backtest trade log"
              rows={tradeRows}
              columns={[
                {
                  id: 'day',
                  header: 'Day',
                  cell: (row) => recordedText(row.trade.day),
                },
                {
                  id: 'stratum',
                  header: 'Stratum',
                  cell: (row) => recordedText(row.trade.stratum),
                },
                {
                  id: 'symbol',
                  header: 'Symbol',
                  cell: (row) => recordedText(row.trade.ticker),
                },
                {
                  id: 'side',
                  header: 'Side',
                  cell: (row) => sentenceCase(row.trade.side),
                },
                {
                  id: 'quantity',
                  header: 'Quantity',
                  cell: (row) => row.trade.qty,
                  align: 'right',
                },
                {
                  id: 'entry',
                  header: 'Entry',
                  cell: (row) => formatUsd(row.trade.entryPrice),
                  align: 'right',
                },
                {
                  id: 'exit',
                  header: 'Exit',
                  cell: (row) => formatUsd(row.trade.exitPrice),
                  align: 'right',
                },
                {
                  id: 'pnl',
                  header: 'P&L',
                  cell: (row) => pnlText(row.trade.pnlUsd),
                  align: 'right',
                },
                {
                  id: 'reason',
                  header: 'Exit reason',
                  cell: (row) => sentenceCase(row.trade.exitReason),
                },
              ]}
              rowKey={(row) => String(row.sourceIndex)}
              emptyMessage="No trades were returned for the selected cell."
            />
          </div>
        ) : null}
      </Pane>
    </main>
  );
}

export default BacktestView;
