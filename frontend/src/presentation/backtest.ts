import type { BacktestCell } from '../types';

export interface BacktestPoint {
  key: string;
  threshold: number;
  bearWeight: number | null;
  pnl: number;
}

export function buildBacktestPoints(cells: readonly BacktestCell[]): BacktestPoint[] {
  return cells
    .flatMap((cell) => {
      const pnl = cell.netPnlUsd;
      if (
        !Number.isFinite(cell.threshold) ||
        typeof pnl !== 'number' ||
        !Number.isFinite(pnl)
      ) return [];
      const bearWeight = cell.bearWeight ?? cell.bear;
      return [{
        key: cell.cell,
        threshold: cell.threshold,
        bearWeight: typeof bearWeight === 'number' && Number.isFinite(bearWeight)
          ? bearWeight
          : null,
        pnl,
      }];
    })
    .sort((a, b) => a.threshold - b.threshold);
}
