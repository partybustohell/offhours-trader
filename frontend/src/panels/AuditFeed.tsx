import type { AuditEvent } from '../types';
import { fmtClock } from '../api';

function summarize(data: unknown): string {
  if (data == null) return '';
  if (typeof data === 'string') return data;
  try {
    const s = JSON.stringify(data);
    return s.length > 240 ? `${s.slice(0, 240)}…` : s;
  } catch {
    return String(data);
  }
}

export default function AuditFeed({ events }: { events: AuditEvent[] }) {
  const sorted = [...events].sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return (
    <section className="panel">
      <h2>Audit feed</h2>
      {sorted.length === 0 ? (
        <p className="empty">No audit events yet.</p>
      ) : (
        <div className="audit-list">
          {sorted.map((e, i) => (
            <div className="audit-row" key={`${e.ts}-${i}`}>
              <span className={`dot dot-${e.kind}`} />
              <span className="audit-ts">{fmtClock(e.ts)}</span>
              <span className="audit-kind">{e.kind}</span>
              <span className="audit-data">{summarize(e.data)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
