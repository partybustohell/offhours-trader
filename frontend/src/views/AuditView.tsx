import { useState } from 'react';
import type { AppData } from '../App';
import type { AuditEvent, AuditKind } from '../types';
import { Card, Empty } from '../ui';

const KINDS: (AuditKind | 'all')[] = [
  'all',
  'thesis',
  'verdict',
  'proposed_order',
  'order_placed',
  'order_rejected',
  'exit',
  'halt',
  'error',
];

function dataStr(e: AuditEvent): string {
  try {
    return typeof e.data === 'string' ? e.data : JSON.stringify(e.data);
  } catch {
    return '';
  }
}

export default function AuditView({ d }: { d: AppData }) {
  const [filter, setFilter] = useState<AuditKind | 'all'>('all');
  const events = filter === 'all' ? d.audit : d.audit.filter((e) => e.kind === filter);

  return (
    <div className="stagger">
      <div className="view-head" style={{ ['--i' as string]: 0 }}>
        <h1 className="view-title">Audit</h1>
        <p className="view-desc">
          Every decision the system made, newest first — nominations, verdicts, the thesis, every
          proposed order and its fate. This file is the record when something looks wrong.
        </p>
      </div>

      <Card
        style={{ ['--i' as string]: 1 } as never}
        title="Event log"
        sub={
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {KINDS.map((k) => (
              <button
                key={k}
                className="tag"
                style={{
                  cursor: 'pointer',
                  color: filter === k ? 'var(--amber-bright)' : undefined,
                  borderColor: filter === k ? 'var(--amber-line)' : undefined,
                }}
                onClick={() => setFilter(k)}
              >
                {k}
              </button>
            ))}
          </div>
        }
      >
        {events.length === 0 ? (
          <Empty>No events{filter !== 'all' ? ` of kind ${filter}` : ''}.</Empty>
        ) : (
          <div className="feed">
            {events.map((e, i) => (
              <div className="feed-row" key={i}>
                <span className="feed-ts">{e.ts.slice(11, 19)}</span>
                <span className="feed-kind">
                  <span className={`dot ${e.kind}`} />
                  {e.kind}
                </span>
                <span className="feed-data">{dataStr(e)}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
