import { describe, expect, it } from 'vitest';
import { backtestFixture } from '../test/fixtures';
import { buildBacktestPoints } from './backtest';

describe('buildBacktestPoints', () => {
  it('maps only returned cells into chart values', () => {
    expect(buildBacktestPoints(backtestFixture.cells ?? [])).toEqual([
      { key: 't070', threshold: 0.7, bearWeight: 0.5, pnl: 125 },
    ]);
  });

  it('retains duplicate thresholds and excludes cells without recorded net P&L', () => {
    const base = backtestFixture.cells![0];
    expect(
      buildBacktestPoints([
        { ...base, cell: 'bear-light', threshold: 0.7, bearWeight: 0.8 },
        { ...base, cell: 'bear-heavy', threshold: 0.7, bearWeight: 1.6 },
        { ...base, cell: 'net-missing', threshold: 0.8, netPnlUsd: null },
      ]),
    ).toEqual([
      { key: 'bear-light', threshold: 0.7, bearWeight: 0.8, pnl: 125 },
      { key: 'bear-heavy', threshold: 0.7, bearWeight: 1.6, pnl: 125 },
    ]);
  });
});
