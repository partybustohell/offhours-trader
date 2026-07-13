import { describe, expect, it } from 'vitest';
import { backtestFixture } from '../test/fixtures';
import { buildBacktestPoints } from './backtest';

describe('buildBacktestPoints', () => {
  it('maps only returned cells into chart values', () => {
    expect(buildBacktestPoints(backtestFixture.cells ?? [])).toEqual([
      { key: 't070', threshold: 0.7, pnl: 125 },
    ]);
  });
});
