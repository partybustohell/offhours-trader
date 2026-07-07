import type { CandidateFile } from '../types';
import { fmtCompactUsd, fmtUsd } from '../api';

export default function CandidatesPanel({ data }: { data: CandidateFile | null }) {
  const candidates = data?.candidates ?? [];
  const rejected = data?.rejected ?? [];
  return (
    <section className="panel">
      <h2>
        Candidates
        {data?.date ? <span className="panel-date">{data.date}</span> : null}
      </h2>
      {candidates.length === 0 ? (
        <p className="empty">No candidates yet. Run the pipeline to discover some.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Ticker</th>
                <th>Last</th>
                <th>Avg $ vol 20d</th>
                <th>Nominated by</th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((c) => (
                <tr key={c.ticker}>
                  <td className="ticker">{c.ticker}</td>
                  <td className="num">{fmtUsd(c.lastPrice)}</td>
                  <td className="num">{fmtCompactUsd(c.avgDollarVolume20d)}</td>
                  <td>
                    {(c.nominatedBy ?? []).map((n, i) => (
                      <span className="tag" key={`${n.analyst}-${i}`} title={n.reason}>
                        {n.analyst}
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rejected.length > 0 ? (
        <details className="collapsed-list">
          <summary>Filtered out ({rejected.length})</summary>
          <ul>
            {rejected.map((r, i) => (
              <li key={`${r.ticker}-${i}`}>
                <span className="ticker">{r.ticker}</span> — {r.reason}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
