import type { BacktestCell } from '../types';

export interface BacktestPoint {
  key: string;
  threshold: number;
  pnl: number;
}

export function buildBacktestPoints(cells: readonly BacktestCell[]): BacktestPoint[] {
  return cells
    .filter((cell) => Number.isFinite(cell.threshold) && Number.isFinite(cell.netPnlUsd))
    .map((cell) => ({ key: cell.cell, threshold: cell.threshold, pnl: cell.netPnlUsd }))
    .sort((a, b) => a.threshold - b.threshold);
}
