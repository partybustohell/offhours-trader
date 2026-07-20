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
        data: {
          order: { ticker: 'AMD', side: 'buy', qty: 20, limitPrice: 172.4 },
          reasons: ['spread exceeded 40 bps'],
        },
      },
      {
        ts: '2026-07-12T04:15:00.000Z',
        kind: 'order_rejected',
        data: {
          order: { ticker: 'WBD', side: 'sell', qty: 10, limitPrice: 9.1 },
          reasons: ['quote was stale'],
        },
      },
    ], new Date('2026-07-12T00:30:00.000Z'));
    expect(rows.map((row) => [row.symbol, row.reason])).toEqual([
      ['AMD', 'Spread exceeded 40 bps.'],
    ]);
  });

  it('joins production risk reasons clinically and preserves the flat legacy shape', () => {
    const rows = buildRiskRejections([
      {
        ts: '2026-07-12T14:00:00.000Z',
        kind: 'order_rejected',
        data: {
          ticker: 'IGNORED',
          reason: 'Ignored legacy reason.',
          order: { ticker: 'AMD', side: 'buy', qty: 20, limitPrice: 172.4 },
          reasons: [
            ' trading halted ',
            '',
            'exceeds max position size!',
            '   ',
            'quote was stale?',
          ],
        },
      },
      {
        ts: '2026-07-12T15:00:00.000Z',
        kind: 'order_rejected',
        data: { ticker: 'WBD', reason: 'spread exceeded 40 bps' },
      },
      {
        ts: '2026-07-12T16:00:00.000Z',
        kind: 'order_rejected',
        data: { order: { ticker: 'BLANK' }, reasons: ['', '  '] },
      },
    ], new Date('2026-07-12T18:00:00.000Z'));

    expect(rows.map((row) => [row.symbol, row.reason])).toEqual([
      [
        'AMD',
        'Trading halted. Exceeds max position size! Quote was stale?',
      ],
      ['WBD', 'Spread exceeded 40 bps.'],
      ['BLANK', 'Reason not recorded.'],
    ]);
  });
});
