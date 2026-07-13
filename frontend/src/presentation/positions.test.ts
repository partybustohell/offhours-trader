import { describe, expect, it } from 'vitest';
import { buildRiskRejections, humanizeBrokerStatus } from './positions';

describe('position presentation', () => {
  it('uses ordinary broker status text', () => {
    expect(humanizeBrokerStatus('partially_filled')).toBe('Partially filled');
  });

  it('skips risk rejections with malformed timestamps', () => {
    const rows = buildRiskRejections([
      {
        ts: 'not-a-timestamp',
        kind: 'order_rejected',
        data: { ticker: 'AMD', reason: 'Spread exceeded 40 bps.' },
      },
    ], new Date('2026-07-12T18:00:00.000Z'));
    expect(rows).toEqual([]);
  });

  it('uses the ET calendar date across the UTC midnight boundary', () => {
    const rows = buildRiskRejections([
      {
        ts: '2026-07-12T00:15:00.000Z',
        kind: 'order_rejected',
        data: { ticker: 'AMD', reason: 'Spread exceeded 40 bps.' },
      },
      {
        ts: '2026-07-12T04:15:00.000Z',
        kind: 'order_rejected',
        data: { ticker: 'WBD', reason: 'Quote was stale.' },
      },
    ], new Date('2026-07-12T00:30:00.000Z'));
    expect(rows.map((row) => row.symbol)).toEqual(['AMD']);
  });
});
