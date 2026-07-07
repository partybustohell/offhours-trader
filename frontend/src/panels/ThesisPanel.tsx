import type { Thesis } from '../types';
import { fmtUsd } from '../api';

function expiryLabel(expiresAt: string): string {
  const t = Date.parse(expiresAt);
  if (!Number.isFinite(t)) return '';
  const diff = t - Date.now();
  if (diff <= 0) return 'expired';
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  return h > 0 ? `expires in ${h}h ${m}m` : `expires in ${m}m`;
}

export default function ThesisPanel({ thesis }: { thesis: Thesis | null }) {
  const entries = thesis?.entries ?? [];
  const skipped = thesis?.skipped ?? [];
  return (
    <section className="panel">
      <h2>
        Thesis
        {thesis?.date ? <span className="panel-date">{thesis.date}</span> : null}
        {thesis?.expiresAt ? <span className="panel-date">{expiryLabel(thesis.expiresAt)}</span> : null}
      </h2>
      {!thesis ? (
        <p className="empty">No thesis yet. Run the pipeline to generate one.</p>
      ) : entries.length === 0 ? (
        <p className="empty">Thesis has no entries — nothing met the bar. Default posture: do nothing.</p>
      ) : (
        entries.map((e) => (
          <article className="thesis-card" key={e.ticker}>
            <div className="thesis-head">
              <span className="ticker">{e.ticker}</span>
              <span className={`pill ${e.direction === 'long' ? 'pill-long' : 'pill-short'}`}>
                {e.direction.toUpperCase()}
              </span>
              <span className="thesis-notional">{fmtUsd(e.targetNotionalUsd)}</span>
            </div>
            <div className="thesis-metrics">
              <span className="metric">
                <span className="metric-label">conviction</span>
                <span className="bar">
                  <span
                    className="bar-fill"
                    style={{ width: `${Math.round(Math.min(1, Math.max(0, e.weightedConviction)) * 100)}%` }}
                  />
                </span>
                <span className="metric-value">{e.weightedConviction.toFixed(2)}</span>
              </span>
              <span className="metric">
                <span className="metric-label">limit band</span>
                <span className="metric-value">
                  {fmtUsd(e.limitBand?.low)} – {fmtUsd(e.limitBand?.high)}
                </span>
              </span>
            </div>
            <p className="narrative">{e.narrative}</p>
            {(e.invalidationConditions ?? []).length > 0 ? (
              <div className="invalidation">
                <span className="detail-sub">Invalidation</span>
                <ul>
                  {e.invalidationConditions.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </article>
        ))
      )}
      {skipped.length > 0 ? (
        <details className="collapsed-list">
          <summary>Skipped ({skipped.length})</summary>
          <ul>
            {skipped.map((s, i) => (
              <li key={`${s.ticker}-${i}`}>
                <span className="ticker">{s.ticker}</span> — {s.reason}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
