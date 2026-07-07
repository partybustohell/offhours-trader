import { useState } from 'react';
import type { Direction, Verdict, VerdictFile } from '../types';
import { ANALYSTS } from '../types';

const GLYPH: Record<Direction, string> = { long: '▲', short: '▼', none: '·' };

export default function VerdictsPanel({ data }: { data: VerdictFile | null }) {
  const [open, setOpen] = useState<string | null>(null);
  const verdicts = data?.verdicts ?? [];
  const dropped = data?.droppedAnalysts ?? [];

  const byKey = new Map<string, Verdict>();
  const tickers: string[] = [];
  for (const v of verdicts) {
    if (!tickers.includes(v.ticker)) tickers.push(v.ticker);
    byKey.set(`${v.ticker}|${v.analyst}`, v);
  }
  tickers.sort();
  const selected = open ? byKey.get(open) : undefined;

  return (
    <section className="panel">
      <h2>
        Verdicts
        {data?.date ? <span className="panel-date">{data.date}</span> : null}
      </h2>
      {verdicts.length === 0 ? (
        <p className="empty">No verdicts yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="matrix">
            <thead>
              <tr>
                <th>Ticker</th>
                {ANALYSTS.map((a) => (
                  <th key={a}>{a}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tickers.map((t) => (
                <tr key={t}>
                  <td className="ticker">{t}</td>
                  {ANALYSTS.map((a) => {
                    const key = `${t}|${a}`;
                    const v = byKey.get(key);
                    if (!v) {
                      return (
                        <td key={a} className="muted">
                          —
                        </td>
                      );
                    }
                    return (
                      <td key={a}>
                        <button
                          className={`cell cell-${v.direction}${open === key ? ' cell-open' : ''}`}
                          onClick={() => setOpen(open === key ? null : key)}
                          title="Click for evidence"
                        >
                          <span className="glyph">{GLYPH[v.direction] ?? '·'}</span>
                          {typeof v.conviction === 'number' ? v.conviction.toFixed(2) : '—'}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {selected ? (
        <div className="verdict-detail">
          <div className="verdict-detail-head">
            <span className="ticker">{selected.ticker}</span> · {selected.analyst} ·{' '}
            {selected.direction} {selected.conviction?.toFixed(2)} · horizon: {selected.horizon}
          </div>
          <span className="detail-sub">Evidence</span>
          <ul>
            {(selected.evidence ?? []).map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
          {(selected.invalidation_conditions ?? []).length > 0 ? (
            <>
              <span className="detail-sub">Invalidation</span>
              <ul>
                {selected.invalidation_conditions.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}
      {dropped.length > 0 ? (
        <p className="dropped">Dropped analysts this run: {dropped.join(', ')}</p>
      ) : null}
    </section>
  );
}
