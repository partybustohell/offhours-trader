import type { AppData } from '../App';
import type { ViewId } from '../router';
import type { AuditEvent, Thesis } from '../types';
import { fmtUsd, isMissingKeysError } from '../api';
import { Card, Conviction, DirPill, Empty, Kpi, untilLabel } from '../ui';

function auditData(e: AuditEvent): string {
  try {
    return typeof e.data === 'string' ? e.data : JSON.stringify(e.data);
  } catch {
    return '';
  }
}

export default function Overview({
  d,
  go,
  activeThesis,
}: {
  d: AppData;
  go: (v: ViewId) => void;
  activeThesis: Thesis | null;
}) {
  const st = d.status;
  const keyless = st?.error && isMissingKeysError(st.error);
  const positions = d.positions.positions;
  const openPl = positions.reduce((s, p) => s + (p.unrealizedPl ?? 0), 0);
  const rejects = d.audit.filter((e) => e.kind === 'order_rejected').length;
  const entries = activeThesis?.entries ?? [];
  const recent = d.audit.slice(0, 9);

  return (
    <div className="stagger">
      <div className="view-head" style={{ ['--i' as string]: 0 }}>
        <h1 className="view-title">Overview</h1>
        <p className="view-desc">
          What the desk is doing right now — the thesis in force, live exposure, and the last
          decisions the system made.
        </p>
        <span className="view-tag">{activeThesis ? `${activeThesis.kind} thesis` : 'no thesis'}</span>
      </div>

      <div className="kpi-row" style={{ ['--i' as string]: 1 }}>
        <Kpi label="Equity" value={keyless ? '—' : fmtUsd(st?.equity)} note="paper account" />
        <Kpi
          label="Open P&L"
          value={positions.length ? fmtUsd(openPl) : '—'}
          tone={openPl > 0 ? 'pos' : openPl < 0 ? 'neg' : undefined}
          note={`${positions.length} position${positions.length === 1 ? '' : 's'}`}
        />
        <Kpi
          label="Thesis entries"
          value={entries.length}
          note={activeThesis ? `expires ${untilLabel(activeThesis.expiresAt)}` : 'idle'}
        />
        <Kpi
          label="Risk rejections"
          value={rejects}
          note="today"
          tone={rejects > 0 ? 'neg' : undefined}
        />
      </div>

      <div className="grid-3 section-gap" style={{ ['--i' as string]: 2 }}>
        <Card
          title="Thesis in force"
          sub={activeThesis ? `${activeThesis.date} · ${activeThesis.kind}` : undefined}
          flush
        >
          {entries.length === 0 ? (
            <div style={{ padding: 16 }}>
              <Empty>
                No entries — nothing cleared the bar. Default posture: do nothing.
                {activeThesis && activeThesis.skipped.length
                  ? ` ${activeThesis.skipped.length} candidate(s) examined and skipped.`
                  : ''}
              </Empty>
            </div>
          ) : (
            <div>
              {entries.slice(0, 4).map((e) => (
                <div
                  key={e.ticker}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '11px 16px',
                    borderBottom: '1px solid var(--line-soft)',
                  }}
                >
                  <span className="ticker mono" style={{ fontSize: 14, width: 62 }}>
                    {e.ticker}
                  </span>
                  <DirPill direction={e.direction} />
                  <div style={{ flex: 1, maxWidth: 160 }}>
                    <Conviction value={e.weightedConviction} />
                  </div>
                  <span className="num" style={{ marginLeft: 'auto', color: 'var(--muted)' }}>
                    {fmtUsd(e.targetNotionalUsd)}
                  </span>
                </div>
              ))}
              <button
                className="btn"
                style={{ margin: 14, marginTop: 12 }}
                onClick={() => go('thesis')}
              >
                Full thesis →
              </button>
            </div>
          )}
        </Card>

        <Card title="Exposure" flush>
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
                    <th className="r">Qty</th>
                    <th className="r">P&L</th>
                  </tr>
                </thead>
                <tbody>
                  {positions.map((p) => (
                    <tr key={p.ticker}>
                      <td>
                        <span className="ticker">{p.ticker}</span>{' '}
                        <span className={`pill ${p.side}`} style={{ marginLeft: 4 }}>
                          {p.side}
                        </span>
                      </td>
                      <td className="r num">{p.qty}</td>
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
      </div>

      <div className="section-gap" style={{ ['--i' as string]: 3 }}>
        <Card
          title="Activity"
          sub={
            <button className="note" style={{ cursor: 'pointer' }} onClick={() => go('audit')}>
              full log →
            </button>
          }
        >
          {recent.length === 0 ? (
            <Empty>No activity yet.</Empty>
          ) : (
            <div className="feed">
              {recent.map((e, i) => (
                <div className="feed-row" key={i}>
                  <span className="feed-ts">{e.ts.slice(11, 19)}</span>
                  <span className="feed-kind">
                    <span className={`dot ${e.kind}`} />
                    {e.kind}
                  </span>
                  <span className="feed-data">{auditData(e).slice(0, 120)}</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
