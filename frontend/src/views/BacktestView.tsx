import { useState, type CSSProperties } from 'react';
import type { AppData } from '../App';
import type { BacktestCell } from '../types';
import { fmtUsd } from '../api';
import { Card, Empty } from '../ui';

// Aggregate the 3 bear-weight cells per threshold into one bar: the story is
// P&L vs threshold, and bear weight barely moves it.
function byThreshold(cells: BacktestCell[]): { threshold: number; pnl: number; trades: number }[] {
  const m = new Map<number, { pnl: number; trades: number; n: number }>();
  for (const c of cells) {
    const g = m.get(c.threshold) ?? { pnl: 0, trades: 0, n: 0 };
    g.pnl += c.netPnlUsd;
    g.trades += c.trades;
    g.n += 1;
    m.set(c.threshold, g);
  }
  return [...m.entries()]
    .map(([threshold, g]) => ({ threshold, pnl: g.pnl / g.n, trades: Math.round(g.trades / g.n) }))
    .sort((a, b) => a.threshold - b.threshold);
}

export default function BacktestView({ d }: { d: AppData }) {
  const [openTrade, setOpenTrade] = useState<number | null>(null);
  const bt = d.backtest;

  if (!bt?.available) {
    return (
      <div className="stagger">
        <div className="view-head" style={{ ['--i' as string]: 0 }}>
          <h1 className="view-title">Backtest</h1>
        </div>
        <Card>
          <Empty>No backtest results yet — run scripts/backtest.ts.</Empty>
        </Card>
      </div>
    );
  }

  const cells = bt.cells ?? [];
  const trades = bt.trades ?? [];
  const bars = byThreshold(cells);
  const maxAbs = Math.max(1, ...bars.map((b) => Math.abs(b.pnl)));

  return (
    <div className="stagger">
      <div className="view-head" style={{ ['--i' as string]: 0 }}>
        <h1 className="view-title">Backtest</h1>
        <p className="view-desc">
          50 episodes, Jan–Jun 2026, $50k. Sign is shown three ways — bar direction, colour, and the
          value — so it reads without relying on red/green.
        </p>
        <span className="view-tag">{bt.tag}</span>
      </div>

      <Card
        title="Net P&L by conviction threshold"
        sub="mean per cell · SIP realism"
        style={{ ['--i' as string]: 1 } as CSSProperties}
      >
        <div className="pnl-chart">
          {bars.map((b) => {
            const h = (Math.abs(b.pnl) / maxAbs) * 50;
            const pos = b.pnl >= 0;
            return (
              <div className="pnl-col" key={b.threshold} title={`${b.trades} trades`}>
                <div className="pnl-plot">
                  <div className="pnl-zero" />
                  <div
                    className={`pnl-bar ${pos ? 'pos' : 'neg'}`}
                    style={{ height: `${h}%` }}
                  />
                  <div
                    className={`pnl-val ${pos ? 'pos' : 'neg'}`}
                    style={pos ? { bottom: `calc(50% + ${h}% + 4px)` } : { top: `calc(50% + ${h}% + 4px)` }}
                  >
                    {b.pnl >= 0 ? '+' : ''}
                    {b.pnl.toFixed(0)}
                  </div>
                </div>
                <div className="pnl-x">
                  {b.threshold.toFixed(2)}
                  <small>{b.trades} trd</small>
                </div>
              </div>
            );
          })}
        </div>
        <p className="note" style={{ marginTop: 12 }}>
          P&L is statistically indistinguishable from zero at every threshold (n ≤ 14) — descriptive
          only, no edge claimed.
        </p>
      </Card>

      <div className="section-gap">
        <Card title="Sweep" sub={`${cells.length} cells`} flush>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Cell</th>
                  <th className="r">Thr</th>
                  <th className="r">Bear</th>
                  <th className="r">Abst</th>
                  <th className="r">Filled</th>
                  <th className="r">Trades</th>
                  <th className="r">Net P&L</th>
                </tr>
              </thead>
              <tbody>
                {cells.map((c) => (
                  <tr key={c.cell}>
                    <td className="ticker">{c.cell}</td>
                    <td className="r num">{c.threshold.toFixed(2)}</td>
                    <td className="r num">{(c.bearWeight ?? c.bear ?? 0).toFixed(1)}</td>
                    <td className="r num">{c.abstained}/50</td>
                    <td className="r num">
                      {c.ordersFilled}/{c.ordersPlaced}
                    </td>
                    <td className="r num">{c.trades}</td>
                    <td className={`r num ${c.netPnlUsd >= 0 ? 'pos' : c.netPnlUsd < 0 ? 'neg' : ''}`}>
                      {fmtUsd(c.netPnlUsd)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      <div className="section-gap">
        <Card title="Trade log" sub={bt.tradeLogCell ?? undefined} flush>
          {trades.length === 0 ? (
            <div style={{ padding: 16 }}>
              <Empty>No trades in any cell.</Empty>
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Day</th>
                    <th>Ticker</th>
                    <th>Side</th>
                    <th className="r">Qty</th>
                    <th className="r">Entry → Exit</th>
                    <th className="r">P&L</th>
                    <th>Exit</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.map((t, i) => {
                    const reason = t.exitReason || '?';
                    return (
                      <tr key={i}>
                        <td className="num">
                          {t.day} <span className="tag">{t.stratum}</span>
                        </td>
                        <td className="ticker">{t.ticker}</td>
                        <td>{t.side}</td>
                        <td className="r num">{t.qty}</td>
                        <td className="r num">
                          {t.entryPrice.toFixed(2)} → {t.exitPrice.toFixed(2)}
                        </td>
                        <td className={`r num ${t.pnlUsd >= 0 ? 'pos' : 'neg'}`}>{fmtUsd(t.pnlUsd)}</td>
                        <td>
                          <button
                            className="note"
                            style={{ cursor: 'pointer', textAlign: 'left' }}
                            title={reason}
                            onClick={() => setOpenTrade(openTrade === i ? null : i)}
                          >
                            {reason.length > 24 ? `${reason.slice(0, 24)}…` : reason}
                          </button>
                          {openTrade === i ? (
                            <div className="note" style={{ marginTop: 6, whiteSpace: 'normal', maxWidth: 340 }}>
                              {reason}
                            </div>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
