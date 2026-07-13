import { useEffect, useMemo, useRef, useState } from 'react';
import { DataTable, type DataColumn } from '../components/workspace/DataTable';
import { Pane } from '../components/workspace/Pane';
import {
  SemanticText,
  type SemanticTone,
} from '../components/workspace/SemanticText';
import { StatusMessage } from '../components/workspace/StatusMessage';
import { presentAuditEvent, type PresentedAuditEvent } from '../presentation/audit';
import { sentenceCase } from '../presentation/format';
import type { AuditEvent } from '../types';

export interface AuditViewProps {
  events: readonly AuditEvent[];
}

const statuses = [
  'completed',
  'skipped',
  'rejected',
  'failed',
  'halted',
  'pending',
  'unknown',
] as const;

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

function stableContent(value: unknown): string {
  if (Array.isArray(value)) {
    return '[' + value.map(stableContent).join(',') + ']';
  }
  if (typeof value === 'object' && value !== null) {
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(
          ([key, entry]) => JSON.stringify(key) + ':' + stableContent(entry),
        )
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(value) ?? String(value);
}

function presentRows(events: readonly AuditEvent[]): PresentedAuditEvent[] {
  const occurrences = new Map<string, number>();
  return events
    .map((event, index) => {
      const contentKey = stableContent([event.ts, event.kind, event.data]);
      const occurrence = occurrences.get(contentKey) ?? 0;
      occurrences.set(contentKey, occurrence + 1);
      return {
        index,
        timestamp: Date.parse(event.ts),
        row: {
          ...presentAuditEvent(event, index),
          id: 'audit-event:' + contentKey + ':' + String(occurrence),
        },
      };
    })
    .sort((a, b) => {
      const aRecorded = Number.isFinite(a.timestamp);
      const bRecorded = Number.isFinite(b.timestamp);
      if (aRecorded && bRecorded) {
        return b.timestamp - a.timestamp || a.index - b.index;
      }
      if (aRecorded) return -1;
      if (bRecorded) return 1;
      return a.index - b.index;
    })
    .map(({ row }) => row);
}

export function AuditView({ events }: AuditViewProps) {
  const [activityFilter, setActivityFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const allRows = useMemo(() => presentRows(events), [events]);
  const previousRowsRef = useRef(allRows);

  useEffect(() => {
    const previousRows = previousRowsRef.current;
    previousRowsRef.current = allRows;
    if (previousRows === allRows) return;

    if (
      activityFilter !== 'all' &&
      previousRows.some((row) => row.activity === activityFilter) &&
      !allRows.some((row) => row.activity === activityFilter)
    ) {
      setActivityFilter('all');
    }
    if (
      statusFilter !== 'all' &&
      previousRows.some((row) => row.status === statusFilter) &&
      !allRows.some((row) => row.status === statusFilter)
    ) {
      setStatusFilter('all');
    }
    if (
      expandedKey !== null &&
      previousRows.some((row) => row.id === expandedKey) &&
      !allRows.some((row) => row.id === expandedKey)
    ) {
      setExpandedKey(null);
    }
  }, [activityFilter, allRows, expandedKey, statusFilter]);
  const activityOptions = [
    ...new Set(allRows.map((row) => row.activity)),
  ].sort();
  const rows = allRows.filter(
    (row) =>
      (activityFilter === 'all' || row.activity === activityFilter) &&
      (statusFilter === 'all' || row.status === statusFilter),
  );
  const columns: DataColumn<PresentedAuditEvent>[] = [
    { id: 'time', header: 'Time (ET)', cell: (row) => row.timestamp },
    { id: 'activity', header: 'Activity', cell: (row) => row.activity },
    {
      id: 'stage',
      header: 'Stage',
      cell: (row) => row.stage,
      mobilePriority: 'secondary',
    },
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
    <main className="route route--audit">
      <Pane
        id="audit"
        title="Audit"
        toolbar={(
          <div className="table-filters">
            <label>
              <span>Filter by activity</span>
              <select
                value={activityFilter}
                onChange={(event) => setActivityFilter(event.target.value)}
              >
                <option value="all">All activity</option>
                {activityOptions.map((activity) => (
                  <option value={activity} key={activity}>
                    {activity}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Filter by status</span>
              <select
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value)}
              >
                <option value="all">All statuses</option>
                {statuses.map((status) => (
                  <option value={status} key={status}>
                    {sentenceCase(status)}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
      >
        {allRows.length === 0 ? (
          <StatusMessage tone="empty">
            No audit events were recorded.
          </StatusMessage>
        ) : (
          <DataTable
            ariaLabel="Audit events"
            rows={rows}
            columns={columns}
            rowKey={(row) => row.id}
            rowLabel={(row) =>
              row.timestamp +
              ' ' +
              row.activity +
              '; status ' +
              sentenceCase(row.status) +
              '; event kind ' +
              row.rawKind +
              '; ' +
              row.description
            }
            emptyMessage="No audit events match these filters."
            expandedKey={expandedKey}
            onToggleExpanded={(row) =>
              setExpandedKey((current) =>
                current === row.id ? null : row.id,
              )
            }
            renderExpanded={(row) => (
              <div className="audit-detail">
                <p>{row.description}</p>
                <dl className="definition-rows">
                  <div>
                    <dt>Timestamp</dt>
                    <dd>{row.timestamp}</dd>
                  </div>
                  <div>
                    <dt>Event kind</dt>
                    <dd>{row.rawKind}</dd>
                  </div>
                  <div>
                    <dt>Known event</dt>
                    <dd>{row.knownKind ? 'Yes' : 'No'}</dd>
                  </div>
                  {row.fields.map((field) => (
                    <div key={field.key}>
                      <dt>{field.label}</dt>
                      <dd>{field.value}</dd>
                    </div>
                  ))}
                </dl>
                <pre>{row.rawJson}</pre>
              </div>
            )}
          />
        )}
      </Pane>
    </main>
  );
}

export default AuditView;
