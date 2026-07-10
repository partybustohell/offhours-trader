import type { AppData } from '../App';
import type { AuditEvent } from '../types';
import { fmtUsd, fmtClock, isMissingKeysError } from '../api';
import { Card, Empty } from '../ui';

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

interface RejectRow {
  ts: string;
  ticker: string;
  side: string;
  reasons: string[];
}
function rejects(audit: AuditEvent[]): RejectRow[] {
  const out: RejectRow[] = [];
  for (const e of audit) {
    if (e.kind !== 'order_rejected') continue;
    const dd = isObj(e.data) ? e.data : {};
    const order = isObj(dd.order) ? dd.order : dd;
    const reasons = Array.isArray(dd.reasons) ? dd.reasons.map(String) : [];
    out.push({
      ts: e.ts,
      ticker: typeof order.ticker === 'string' ? order.ticker : '?',
      side: typeof order.side === 'string' ? order.side : '',
      reasons,
    });
  }
  return out;
}

export default function PositionsView({ d }: { d: AppData }) {
  const positions = d.positions.positions;
  const orders = d.orders.orders;
  const rej = rejects(d.audit);
  const posErr = d.positions.error && !isMissingKeysError(d.positions.error) ? d.positions.error : null;

  return (
    <div className="stagger">
      <div className="view-head" style={{ ['--i' as string]: 0 }}>
        <h1 className="view-title">Positions &amp; Orders</h1>
        <p className="view-desc">
          Live exposure, working and filled orders from the broker, and everything the deterministic
          risk gate refused.
        </p>
      </div>

      <Card title="Positions" sub={`${positions.length}`} flush>
        {posErr ? <p className="err" style={{ padding: 14 }}>{posErr}</p> : null}
        {positions.length === 0 ? (
          <div style={{ padding: 16 }}>
            <Empty>Flat — no open positions.</Empty>
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Ticker</th>
                  <th>Side</th>
                  <th className="r">Qty</th>
                  <th className="r">Avg entry</th>
                  <th className="r">Market value</th>
                  <th className="r">Unrealized P&L</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => (
                  <tr key={p.ticker}>
                    <td>
                      <span className="ticker">{p.ticker}</span>
                    </td>
                    <td>
                      <span className={`pill ${p.side}`}>{p.side}</span>
                    </td>
                    <td className="r num">{p.qty}</td>
                    <td className="r num">{fmtUsd(p.avgEntryPrice)}</td>
                    <td className="r num">{fmtUsd(p.marketValue)}</td>
                    <td className={`r num ${p.unrealizedPl >= 0 ? 'pos' : 'neg'}`}>
                      {fmtUsd(p.unrealizedPl)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="section-gap">
        <Card title="Orders" sub={`${orders.length} today`} flush>
          {orders.length === 0 ? (
            <div style={{ padding: 16 }}>
              <Empty>No orders today.</Empty>
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Ticker</th>
                    <th>Side</th>
                    <th className="r">Qty</th>
                    <th className="r">Price</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((o) => (
                    <tr key={o.id}>
                      <td className="num">{fmtClock(o.submittedAt)}</td>
                      <td>
                        <span className="ticker">{o.ticker}</span>
                      </td>
                      <td>{o.side}</td>
                      <td className="r num">{o.qty}</td>
                      <td className="r num">
                        {o.stopPrice != null ? (
                          <span
                            title={`${o.type ?? 'stop'} order · ${(o.timeInForce ?? '').toUpperCase()} · triggers at ${fmtUsd(o.stopPrice)}`}
                          >
                            {fmtUsd(o.stopPrice)}{' '}
                            <span className="tag-stop">
                              STOP{o.timeInForce === 'gtc' ? ' · GTC' : o.timeInForce === 'day' ? ' · DAY' : ''}
                            </span>
                          </span>
                        ) : (
                          fmtUsd(o.limitPrice)
                        )}
                      </td>
                      <td className="note">{o.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <div className="section-gap">
        <Card title="Rejected by risk gate" sub={`${rej.length}`} edge={rej.length ? 'red' : undefined} flush>
          {rej.length === 0 ? (
            <div style={{ padding: 16 }}>
              <Empty>No rejections — every proposed order passed.</Empty>
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Ticker</th>
                    <th>Side</th>
                    <th>Reasons</th>
                  </tr>
                </thead>
                <tbody>
                  {rej.map((r, i) => (
                    <tr key={i}>
                      <td className="num">{r.ts.slice(11, 19)}</td>
                      <td>
                        <span className="ticker">{r.ticker}</span>
                      </td>
                      <td>{r.side}</td>
                      <td className="reasons">{r.reasons.join('; ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
