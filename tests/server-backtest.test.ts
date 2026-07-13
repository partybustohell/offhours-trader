import { describe, expect, it } from 'vitest';
import { resolveBacktestNetPnl } from '../src/server-backtest.js';

describe('resolveBacktestNetPnl', () => {
  it('prefers a finite legacy net value over the modern field', () => {
    expect(
      resolveBacktestNetPnl({ netPnlUsd: 12.5, netPnlTotalUsd: 41.25 }),
    ).toBe(12.5);
    expect(resolveBacktestNetPnl({ netPnlUsd: 0, netPnlTotalUsd: 41.25 })).toBe(0);
  });

  it('uses the finite modern net value when the legacy value is unavailable', () => {
    expect(resolveBacktestNetPnl({ netPnlTotalUsd: 41.25 })).toBe(41.25);
    expect(
      resolveBacktestNetPnl({ netPnlUsd: Number.NaN, netPnlTotalUsd: -8.75 }),
    ).toBe(-8.75);
  });

  it('returns null instead of deriving net P&L from trades', () => {
    const tradeOnlyRecord = {
      netPnlUsd: undefined,
      netPnlTotalUsd: undefined,
      trades: [{ pnlUsd: 90 }, { pnlUsd: -10 }],
    };
    expect(resolveBacktestNetPnl(tradeOnlyRecord)).toBeNull();
    expect(
      resolveBacktestNetPnl({
        netPnlUsd: Number.POSITIVE_INFINITY,
        netPnlTotalUsd: '80',
      }),
    ).toBeNull();
  });
});
