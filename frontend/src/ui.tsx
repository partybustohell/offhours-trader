import type { CSSProperties, ReactNode } from 'react';

export function Card({
  title,
  sub,
  edge,
  flush,
  children,
  className,
  style,
}: {
  title?: string;
  sub?: ReactNode;
  edge?: 'amber' | 'green' | 'red';
  flush?: boolean;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      className={`card${edge ? ` edge-${edge}` : ''}${className ? ` ${className}` : ''}`}
      style={style}
    >
      {title ? (
        <div className="card-head">
          <span className="label">{title}</span>
          {sub ? <span className="sub">{sub}</span> : null}
        </div>
      ) : null}
      <div className={`card-body${flush ? ' flush' : ''}`}>{children}</div>
    </div>
  );
}

export function Kpi({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  tone?: 'pos' | 'neg';
}) {
  return (
    <div className="kpi">
      <div className="label">{label}</div>
      <div className={`kpi-val${tone ? ` ${tone}` : ''}`}>{value}</div>
      {note ? <div className="kpi-note">{note}</div> : null}
    </div>
  );
}

export function Conviction({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(1, value));
  return (
    <div className="conv">
      <div className="conv-track">
        <div className="conv-fill" style={{ width: `${pct * 100}%` }} />
      </div>
      <span className="conv-val">{value.toFixed(2)}</span>
    </div>
  );
}

export function DirPill({ direction }: { direction: string }) {
  const cls = direction === 'long' ? 'long' : direction === 'short' ? 'short' : 'neutral';
  return <span className={`pill ${cls}`}>{direction.toUpperCase()}</span>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

/** Elapsed / remaining time from an ISO instant, human-compact. */
export function untilLabel(iso: string): string {
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms)) return '';
  if (ms <= 0) return 'expired';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
