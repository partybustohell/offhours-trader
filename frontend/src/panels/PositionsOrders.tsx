import type { AuditEvent, BrokerOrder, Position } from '../types';
import { fmtClock, fmtUsd } from '../api';

interface Props {
  positions: Position[];
  positionsError?: string;
  orders: BrokerOrder[];
  ordersError?: string;
  audit: AuditEvent[];
}

interface RejectedRow {
  ts: string;
  ticker: string;
  side: string;
  qty: string;
  limitPrice: string;
  reasons: string[];
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Risk-gate rejections never reach the broker, so they come from the audit
// log (kind 'order_rejected') rather than /api/orders.
function rejectedRows(events: AuditEvent[]): RejectedRow[] {
  const rows: RejectedRow[] = [];
  for (const e of events) {
    if (e.kind !== 'order_rejected') continue;
    const d = isObj(e.data) ? e.data : {};
    const order = isObj(d.order) ? d.order : d;
    const decision = isObj(d.decision) ? d.decision : null;
    const reasons = Array.isArray(d.reasons)
      ? d.reasons.map(String)
      : decision && Array.isArray(decision.reasons)
        ? decision.reasons.map(String)
        : [];
    rows.push({
      ts: e.ts,
      ticker: typeof order.ticker === 'string' ? order.ticker : '?',
      side: typeof order.side === 'string' ? order.side : '',
      qty: typeof order.qty === 'number' ? String(order.qty) : '',
      limitPrice: typeof order.limitPrice === 'number' ? fmtUsd(order.limitPrice) : '',
      reasons,
    });
  }
  return rows;
}

export default function PositionsOrders({
  positions,
  positionsError,
  orders,
  ordersError,
  audit,
}: Props) {
  const rejected = rejectedRows(audit);
  return (
    <section className="panel">
      <h2>Positions &amp; orders</h2>

      <h3>Positions</h3>
      {positionsError ? <p className="inline-error">{positionsError}</p> : null}
      {positions.length === 0 ? (
        <p className="empty">No open positions.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Ticker</th>
                <th>Side</th>
                <th>Qty</th>
                <th>Avg entry</th>
                <th>Mkt value</th>
                <th>Unrealized P&amp;L</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => (
                <tr key={p.ticker}>
                  <td className="ticker">{p.ticker}</td>
                  <td>
                    <span className={`pill ${p.side === 'long' ? 'pill-long' : 'pill-short'}`}>
                      {p.side?.toUpperCase()}
                    </span>
                  </td>
                  <td className="num">{p.qty}</td>
                  <td className="num">{fmtUsd(p.avgEntryPrice)}</td>
                  <td className="num">{fmtUsd(p.marketValue)}</td>
                  <td className={`num ${p.unrealizedPl >= 0 ? 'pl-pos' : 'pl-neg'}`}>
                    {fmtUsd(p.unrealizedPl)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3>Orders</h3>
      {ordersError ? <p className="inline-error">{ordersError}</p> : null}
      {orders.length === 0 ? (
        <p className="empty">No orders today.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Ticker</th>
                <th>Side</th>
                <th>Qty</th>
                <th>Limit</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id}>
                  <td className="num">{fmtClock(o.submittedAt)}</td>
                  <td className="ticker">{o.ticker}</td>
                  <td>{o.side}</td>
                  <td className="num">{o.qty}</td>
                  <td className="num">{fmtUsd(o.limitPrice)}</td>
                  <td className={o.status === 'rejected' || o.status === 'canceled' ? 'status-bad' : ''}>
                    {o.status}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {rejected.length > 0 ? (
        <>
          <h3>Rejected by risk gate</h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Ticker</th>
                  <th>Side</th>
                  <th>Qty</th>
                  <th>Limit</th>
                  <th>Reasons</th>
                </tr>
              </thead>
              <tbody>
                {rejected.map((r, i) => (
                  <tr key={`${r.ts}-${i}`}>
                    <td className="num">{fmtClock(r.ts)}</td>
                    <td className="ticker">{r.ticker}</td>
                    <td>{r.side}</td>
                    <td className="num">{r.qty}</td>
                    <td className="num">{r.limitPrice}</td>
                    <td className="reasons">{r.reasons.join('; ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </section>
  );
}
