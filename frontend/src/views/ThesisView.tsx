import { Fragment, useState } from 'react';
import type { AppData } from '../App';
import type { Thesis, Verdict } from '../types';
import { ANALYSTS } from '../types';
import { fmtUsd } from '../api';
import { Card, Conviction, DirPill, Empty, untilLabel } from '../ui';

export default function ThesisView({ d }: { d: AppData }) {
  const theses = [d.thesis, d.thesisRth].filter((t): t is Thesis => !!t);
  return (
    <div className="stagger">
      <div className="view-head" style={{ ['--i' as string]: 0 }}>
        <h1 className="view-title">Thesis</h1>
        <p className="view-desc">
          The panel&apos;s cohesive view — each entry is the synthesis of five analysts&apos;
          verdicts, sized to conviction. The argument is set in serif; the numbers in mono.
        </p>
      </div>

      {theses.length === 0 ? (
        <Card>
          <Empty>No thesis generated yet. Run the pipeline.</Empty>
        </Card>
      ) : (
        theses.map((t, ti) => (
          <div key={t.kind} style={{ ['--i' as string]: ti + 1 }} className="stack section-gap">
            <div className="view-head" style={{ marginBottom: 4 }}>
              <span className="label" style={{ fontSize: 12 }}>
                {t.kind === 'rth' ? 'Regular session' : 'Off-hours'}
              </span>
              <span className="view-tag">
                {t.date} · {t.entries.length} entries · expires {untilLabel(t.expiresAt)}
              </span>
            </div>
            {t.entries.length === 0 ? (
              <Card>
                <Empty>
                  Nothing cleared the bar. {t.skipped.length} candidate(s) examined and skipped.
                </Empty>
              </Card>
            ) : (
              t.entries.map((e) => (
                <div className={`card entry edge-${e.direction === 'long' ? 'green' : 'red'}`} key={e.ticker}>
                  <div className="entry-head">
                    <span className="ticker">{e.ticker}</span>
                    <DirPill direction={e.direction} />
                    <span className="entry-notional">{fmtUsd(e.targetNotionalUsd)}</span>
                  </div>
                  <div className="entry-meta">
                    <div className="metric">
                      <div className="label">Conviction</div>
                      <div style={{ width: 130 }}>
                        <Conviction value={e.weightedConviction} />
                      </div>
                    </div>
                    <div className="metric">
                      <div className="label">Limit band</div>
                      <div className="metric-v">
                        {e.limitBand.low.toFixed(2)} – {e.limitBand.high.toFixed(2)}
                      </div>
                    </div>
                    <div className="metric">
                      <div className="label">Notional</div>
                      <div className="metric-v">{fmtUsd(e.targetNotionalUsd)}</div>
                    </div>
                  </div>
                  {e.narrative ? <p className="narr">{e.narrative}</p> : null}
                  {e.invalidationConditions.length ? (
                    <>
                      <div className="label" style={{ marginTop: 12, marginBottom: 4 }}>
                        Invalidation
                      </div>
                      <ul className="inval">
                        {e.invalidationConditions.map((c, i) => (
                          <li key={i}>{c}</li>
                        ))}
                      </ul>
                    </>
                  ) : null}
                </div>
              ))
            )}
            {t.skipped.length ? (
              <Card title="Skipped" sub={`${t.skipped.length}`}>
                <div>
                  {t.skipped.map((s, i) => (
                    <span key={i} className="tag">
                      {s.ticker} · {s.reason}
                    </span>
                  ))}
                </div>
              </Card>
            ) : null}
          </div>
        ))
      )}

      <div className="grid-2 section-gap" style={{ ['--i' as string]: 6 }}>
        <VerdictMatrix verdicts={d.verdicts?.verdicts ?? []} />
        <Candidates d={d} />
      </div>
    </div>
  );
}

function VerdictMatrix({ verdicts }: { verdicts: Verdict[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const tickers = [...new Set(verdicts.map((v) => v.ticker.toUpperCase()))];
  const at = (tk: string, an: string) =>
    verdicts.find((v) => v.ticker.toUpperCase() === tk && v.analyst === an);
  const glyph: Record<string, string> = { long: '▲', short: '▼', none: '·' };
  return (
    <Card title="Verdicts" sub={`${tickers.length} × 5`} flush>
      {tickers.length === 0 ? (
        <div style={{ padding: 16 }}>
          <Empty>No verdicts.</Empty>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="matrix">
            <thead>
              <tr>
                <th>Ticker</th>
                {ANALYSTS.map((a) => (
                  <th key={a} className="r">
                    {a.slice(0, 4)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tickers.map((tk) => (
                <Fragment key={tk}>
                  <tr>
                    <td>
                      <button
                        className="ticker"
                        style={{ cursor: 'pointer' }}
                        onClick={() => setOpen(open === tk ? null : tk)}
                      >
                        {tk}
                      </button>
                    </td>
                    {ANALYSTS.map((a) => {
                      const v = at(tk, a);
                      const dir = v?.direction ?? 'none';
                      return (
                        <td key={a} className="r">
                          <span className={`cell-v ${dir}`}>
                            {glyph[dir]}
                            {v && dir !== 'none' ? v.conviction.toFixed(2) : ''}
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                  {open === tk ? (
                    <tr>
                      <td colSpan={6} style={{ background: 'var(--bg-2)' }}>
                        <div className="stack" style={{ gap: 8 }}>
                          {verdicts
                            .filter((v) => v.ticker.toUpperCase() === tk)
                            .map((v, i) => (
                              <div key={i}>
                                <span className="label">{v.analyst}</span>{' '}
                                <span className={`cell-v ${v.direction}`}>{v.direction}</span>
                                {v.evidence.length ? (
                                  <ul className="list" style={{ marginTop: 3 }}>
                                    {v.evidence.slice(0, 3).map((ev, j) => (
                                      <li key={j}>{ev}</li>
                                    ))}
                                  </ul>
                                ) : null}
                              </div>
                            ))}
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function Candidates({ d }: { d: AppData }) {
  const c = d.candidates;
  return (
    <Card title="Candidates" sub={c ? `${c.candidates.length} kept` : undefined} flush>
      {!c || c.candidates.length === 0 ? (
        <div style={{ padding: 16 }}>
          <Empty>No candidates discovered.</Empty>
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Ticker</th>
                <th>Nominated by</th>
              </tr>
            </thead>
            <tbody>
              {c.candidates.map((cd) => (
                <tr key={cd.ticker}>
                  <td>
                    <span className="ticker">{cd.ticker}</span>
                  </td>
                  <td>
                    {cd.nominatedBy.map((n, i) => (
                      <span key={i} className="tag" title={n.reason}>
                        {n.analyst.slice(0, 4)}
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {c.rejected.length ? (
            <div style={{ padding: '10px 14px', borderTop: '1px solid var(--line-soft)' }}>
              <span className="label">Filtered out ({c.rejected.length})</span>
              <div style={{ marginTop: 6 }}>
                {c.rejected.map((r, i) => (
                  <span key={i} className="tag">
                    {r.ticker} · {r.reason}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </Card>
  );
}
