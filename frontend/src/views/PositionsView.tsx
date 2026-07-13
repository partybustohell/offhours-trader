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

type PositionsTab = 'positions' | 'orders' | 'rejections';

type PositionRow =
  | { kind: 'position'; key: string; value: Position }
  | { kind: 'order'; key: string; value: BrokerOrder }
  | { kind: 'rejection'; key: string; value: RiskRejectionRow };

const warningBrokerStatuses = new Set([
  'accepted',
  'accepted_for_bidding',
  'calculated',
  'canceled',
  'cancelled',
  'closed',
  'done_for_day',
  'expired',
  'new',
  'partially_filled',
  'pending',
  'pending_cancel',
  'pending_new',
  'pending_replace',
  'replaced',
  'stopped',
  'suspended',
]);

function rowKey(row: PositionRow): string {
  return row.key;
}

function positionKey(position: Position): string {
  return 'position:' + position.ticker;
}

function orderKey(order: BrokerOrder): string {
  return 'order:' + order.id;
}

function rejectionKey(rejection: RiskRejectionRow): string {
  return 'rejection:' + rejection.id;
}

function etDate(value: Date): string | null {
  if (!Number.isFinite(value.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(value);
}

function submittedTodayEt(order: BrokerOrder, today: string | null): boolean {
  if (today === null) return false;
  const submittedAt = new Date(order.submittedAt);
  return Number.isFinite(submittedAt.getTime()) && etDate(submittedAt) === today;
}

function positionSide(side: Position['side']) {
  return (
    <span
      className={
        side === 'long' ? 'semantic-text--positive' : 'semantic-text--negative'
      }
    >
      {sentenceCase(side)}
    </span>
  );
}

function positionPnl(value: number) {
  const recorded = Number.isFinite(value);
  const className = !recorded || value === 0
    ? undefined
    : value > 0
      ? 'semantic-text--positive'
      : 'semantic-text--negative';
  const text = recorded && value > 0 ? '+' + formatUsd(value) : formatUsd(value);
  return <span className={className}>{text}</span>;
}

function brokerStatusClass(status: string): string | undefined {
  const normalized = status.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (normalized === 'filled' || normalized === 'completed') {
    return 'semantic-text--positive';
  }
  if (normalized === 'rejected') return 'semantic-text--negative';
  if (warningBrokerStatuses.has(normalized)) {
    return 'semantic-text--warning';
  }
  return undefined;
}

function brokerStatus(status: string) {
  return (
    <span className={brokerStatusClass(status)}>
      {humanizeBrokerStatus(status)}
    </span>
  );
}

function recordedText(value: string | null | undefined): string {
  const recorded = value?.trim();
  return recorded ? recorded : 'Not recorded';
}

function recordedNumber(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? String(value)
    : 'Not available';
}

function backLabel(tab: PositionsTab): string {
  if (tab === 'orders') return 'Back to orders';
  if (tab === 'rejections') return 'Back to risk rejections';
  return 'Back to positions';
}

export function PositionsView({
  positions,
  orders,
  audit,
  now = new Date(),
}: PositionsViewProps) {
  const [tab, setTab] = useState<PositionsTab>('positions');
  const today = etDate(now);
  const todaysOrders = useMemo(
    () => orders.orders.filter((order) => submittedTodayEt(order, today)),
    [orders.orders, today],
  );
  const rejections = useMemo(() => buildRiskRejections(audit, now), [audit, now]);
  const rows: PositionRow[] = tab === 'positions'
    ? positions.error
      ? []
      : positions.positions.map((value) => ({
          kind: 'position',
          key: positionKey(value),
          value,
        }))
    : tab === 'orders'
      ? orders.error
        ? []
        : todaysOrders.map((value) => ({
            kind: 'order',
            key: orderKey(value),
            value,
          }))
      : rejections.map((value) => ({
          kind: 'rejection',
          key: rejectionKey(value),
          value,
        }));
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
        setTab(next as PositionsTab);
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
            { id: 'side', header: 'Side', cell: (row) => positionSide(row.side) },
            {
              id: 'quantity',
              header: 'Quantity',
              cell: (row) => row.qty,
              align: 'right',
            },
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
              cell: (row) => positionPnl(row.unrealizedPl),
              align: 'right',
              mobilePriority: 'secondary',
            },
          ]}
          rowKey={positionKey}
          rowLabel={(row) => 'Inspect ' + row.ticker + ' position'}
          selectedKey={
            selection.selectedItem?.kind === 'position'
              ? selection.selectedItem.key
              : null
          }
          onSelect={(value) =>
            selection.select({
              kind: 'position',
              key: positionKey(value),
              value,
            })
          }
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
          rows={todaysOrders}
          columns={[
            { id: 'symbol', header: 'Symbol', cell: (row) => row.ticker },
            { id: 'side', header: 'Side', cell: (row) => sentenceCase(row.side) },
            {
              id: 'quantity',
              header: 'Quantity',
              cell: (row) => recordedNumber(row.qty),
              align: 'right',
              mobilePriority: 'secondary',
            },
            {
              id: 'status',
              header: 'Status',
              cell: (row) => brokerStatus(row.status),
            },
            {
              id: 'time',
              header: 'Submitted (ET)',
              cell: (row) => formatEtTimestamp(row.submittedAt),
              mobilePriority: 'secondary',
            },
          ]}
          rowKey={orderKey}
          rowLabel={(row) => 'Inspect order ' + row.id}
          selectedKey={
            selection.selectedItem?.kind === 'order'
              ? selection.selectedItem.key
              : null
          }
          onSelect={(value) =>
            selection.select({ kind: 'order', key: orderKey(value), value })
          }
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
          rowKey={rejectionKey}
          rowLabel={(row) => 'Inspect ' + row.symbol + ' rejection'}
          selectedKey={
            selection.selectedItem?.kind === 'rejection'
              ? selection.selectedItem.key
              : null
          }
          onSelect={(value) =>
            selection.select({
              kind: 'rejection',
              key: rejectionKey(value),
              value,
            })
          }
          emptyMessage="No orders were rejected by the risk checks today."
        />
      ) : null}
    </Pane>
  );

  const selected = selection.selectedItem;
  const detail = (
    <Pane id="position-detail" title="Detail">
      {!selected ? (
        <StatusMessage tone="empty">
          Select a row to inspect its recorded fields.
        </StatusMessage>
      ) : selected.kind === 'position' ? (
        <dl className="definition-rows">
          <div><dt>Symbol</dt><dd>{selected.value.ticker}</dd></div>
          <div><dt>Side</dt><dd>{positionSide(selected.value.side)}</dd></div>
          <div><dt>Quantity</dt><dd>{selected.value.qty}</dd></div>
          <div><dt>Average entry</dt><dd>{formatUsd(selected.value.avgEntryPrice)}</dd></div>
          <div><dt>Market value</dt><dd>{formatUsd(selected.value.marketValue)}</dd></div>
          <div><dt>Open gain/loss</dt><dd>{positionPnl(selected.value.unrealizedPl)}</dd></div>
        </dl>
      ) : selected.kind === 'order' ? (
        <dl className="definition-rows">
          <div><dt>Symbol</dt><dd>{recordedText(selected.value.ticker)}</dd></div>
          <div><dt>Side</dt><dd>{sentenceCase(selected.value.side)}</dd></div>
          <div><dt>Quantity</dt><dd>{recordedNumber(selected.value.qty)}</dd></div>
          <div><dt>Type</dt><dd>{sentenceCase(selected.value.type ?? '')}</dd></div>
          <div>
            <dt>Time in force</dt>
            <dd>{sentenceCase(selected.value.timeInForce ?? '')}</dd>
          </div>
          <div><dt>Order ID</dt><dd>{recordedText(selected.value.id)}</dd></div>
          <div><dt>Client order ID</dt><dd>{recordedText(selected.value.clientOrderId)}</dd></div>
          <div><dt>Status</dt><dd>{brokerStatus(selected.value.status)}</dd></div>
          <div><dt>Raw broker status</dt><dd>{recordedText(selected.value.status)}</dd></div>
          <div><dt>Submitted</dt><dd>{formatEtTimestamp(selected.value.submittedAt)}</dd></div>
          <div><dt>Limit price</dt><dd>{formatUsd(selected.value.limitPrice)}</dd></div>
          <div><dt>Stop price</dt><dd>{formatUsd(selected.value.stopPrice)}</dd></div>
          <div><dt>Filled quantity</dt><dd>{recordedNumber(selected.value.filledQty)}</dd></div>
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
        backLabel={backLabel(tab)}
        onDetailClose={selection.closeDetail}
      />
    </main>
  );
}

export default PositionsView;
