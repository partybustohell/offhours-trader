export interface BacktestNetPnlSource {
  netPnlUsd?: unknown;
  netPnlTotalUsd?: unknown;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function resolveBacktestNetPnl(
  source: BacktestNetPnlSource,
): number | null {
  if (finiteNumber(source.netPnlUsd)) return source.netPnlUsd;
  if (finiteNumber(source.netPnlTotalUsd)) return source.netPnlTotalUsd;
  return null;
}
