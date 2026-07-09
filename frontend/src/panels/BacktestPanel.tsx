import { useState } from 'react';
import type { BacktestResponse } from '../types';
import { fmtUsd } from '../api';

function pnlClass(n: number): string {
  return n > 0 ? 'pl-pos' : n < 0 ? 'pl-neg' : '';
}

export default function BacktestPanel({ data }: { data: BacktestResponse | null }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!data?.available) {
    return (
      <section className="panel">
        <h2>Backtest</h2>
        <p className="empty">No backtest results yet — run scripts/backtest.ts.</p>
      </section>
    );
  }
  const cells = data.cells ?? [];
  const trades = data.trades ?? [];
  return (
    <section className="panel">
      <h2>
        Backtest
        <span className="panel-date">
          {data.tag}
          {data.generatedAt ? ` · ${data.generatedAt.slice(0, 10)}` : ''}
        </span>
      </h2>

      <h3>Sweep — threshold × bear weight</h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>cell</th>
              <th>thr</th>
              <th>bear</th>
              <th>abst</th>
              <th>placed</th>
              <th>filled</th>
              <th>trades</th>
              <th>net P&amp;L</th>
            </tr>
          </thead>
          <tbody>
            {cells.map((c) => (
              <tr key={c.cell}>
                <td className="ticker">{c.cell}</td>
                <td className="num">{c.threshold.toFixed(2)}</td>
                <td className="num">{(c.bearWeight ?? c.bear ?? 0).toFixed(1)}</td>
                <td className="num">{c.abstained}/50</td>
                <td className="num">{c.ordersPlaced}</td>
                <td className="num">{c.ordersFilled}</td>
                <td className="num">{c.trades}</td>
                <td className={`num ${pnlClass(c.netPnlUsd)}`}>{fmtUsd(c.netPnlUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3>
        Trade log <span className="panel-date">({data.tradeLogCell ?? '—'})</span>
      </h3>
      {trades.length === 0 ? (
        <p className="empty">No trades in any cell.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>day</th>
                <th>ticker</th>
                <th>side</th>
                <th>qty</th>
                <th>entry → exit</th>
                <th>P&amp;L</th>
                <th>exit</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((t, i) => {
                const key = `${t.day}-${t.ticker}-${i}`;
                const reason = t.exitReason || '?';
                const short = reason.length > 26 ? `${reason.slice(0, 26)}…` : reason;
                return (
                  <tr key={key}>
                    <td className="num">
                      {t.day} <span className="tag">{t.stratum}</span>
                    </td>
                    <td className="ticker">{t.ticker}</td>
                    <td>{t.side}</td>
                    <td className="num">{t.qty}</td>
                    <td className="num">
                      {t.entryPrice.toFixed(2)} → {t.exitPrice.toFixed(2)}
                    </td>
                    <td className={`num ${pnlClass(t.pnlUsd)}`}>{fmtUsd(t.pnlUsd)}</td>
                    <td>
                      <button
                        type="button"
                        className="cell"
                        title={reason}
                        onClick={() => setOpen(open === key ? null : key)}
                      >
                        {short}
                      </button>
                      {open === key ? <div className="verdict-detail">{reason}</div> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="empty" style={{ marginTop: 8 }}>
        SIP-quote realism mode; episode protocol truncates holds at ~27h. n is too small for
        any edge claim — descriptive only.
      </p>
    </section>
  );
}
