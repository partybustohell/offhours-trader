import { describe, expect, it } from 'vitest';
import { ConfigSchema, type Config } from '../src/config.js';
import { entryTimingAllowed, hmToMinutes } from '../src/session-risk.js';
import type { Session } from '../src/types.js';

const cfg = (overrides: Record<string, unknown> = {}): Config => ConfigSchema.parse(overrides);
const at = (hm: string): number => hmToMinutes(hm);

describe('hmToMinutes', () => {
  it('parses HH:MM to minutes since ET midnight', () => {
    expect(hmToMinutes('00:00')).toBe(0);
    expect(hmToMinutes('09:30')).toBe(570);
    expect(hmToMinutes('16:00')).toBe(960);
    expect(hmToMinutes('08:00')).toBe(480);
  });

  it('throws on malformed input', () => {
    expect(() => hmToMinutes('8am')).toThrow(/invalid HH:MM/);
    expect(() => hmToMinutes('08')).toThrow(/invalid HH:MM/);
  });
});

describe('entryTimingAllowed (defaults: open/close 10 min, premarket 08:00, afterhours 18:00)', () => {
  const c = cfg();

  it('blocks the first 10 minutes of RTH and allows from 09:40', () => {
    expect(entryTimingAllowed('rth', at('09:39'), c)).toBe(false);
    expect(entryTimingAllowed('rth', at('09:40'), c)).toBe(true);
    expect(entryTimingAllowed('rth', at('09:30'), c)).toBe(false);
  });

  it('allows through 15:49 and blocks the last 10 minutes before the close', () => {
    expect(entryTimingAllowed('rth', at('15:49'), c)).toBe(true);
    expect(entryTimingAllowed('rth', at('15:50'), c)).toBe(false);
    expect(entryTimingAllowed('rth', at('15:59'), c)).toBe(false);
  });

  it('allows mid-session RTH', () => {
    expect(entryTimingAllowed('rth', at('12:00'), c)).toBe(true);
  });

  it('blocks deep premarket before 08:00 and allows from 08:00', () => {
    expect(entryTimingAllowed('premarket', at('07:59'), c)).toBe(false);
    expect(entryTimingAllowed('premarket', at('08:00'), c)).toBe(true);
    expect(entryTimingAllowed('premarket', at('04:00'), c)).toBe(false);
  });

  it('allows afterhours through 17:59 and blocks at/after 18:00', () => {
    expect(entryTimingAllowed('afterhours', at('17:59'), c)).toBe(true);
    expect(entryTimingAllowed('afterhours', at('18:00'), c)).toBe(false);
    expect(entryTimingAllowed('afterhours', at('19:59'), c)).toBe(false);
  });

  it('always blocks the closed session', () => {
    for (const m of [0, at('03:00'), at('12:00'), at('21:00')]) {
      expect(entryTimingAllowed('closed' as Session, m, c)).toBe(false);
    }
  });

  it('honors custom blackout widths', () => {
    const wide = cfg({ entry_blackout: { rth_open_min: 30, rth_close_min: 15, premarket_start_hm: '09:00', afterhours_end_hm: '17:00' } });
    expect(entryTimingAllowed('rth', at('09:59'), wide)).toBe(false); // 30-min open blackout
    expect(entryTimingAllowed('rth', at('10:00'), wide)).toBe(true);
    expect(entryTimingAllowed('rth', at('15:45'), wide)).toBe(false); // 15-min close blackout
    expect(entryTimingAllowed('premarket', at('08:59'), wide)).toBe(false);
    expect(entryTimingAllowed('afterhours', at('17:00'), wide)).toBe(false);
  });

  it('a zero-width RTH blackout allows the whole session', () => {
    const none = cfg({ entry_blackout: { rth_open_min: 0, rth_close_min: 0 } });
    expect(entryTimingAllowed('rth', at('09:30'), none)).toBe(true);
    expect(entryTimingAllowed('rth', at('15:59'), none)).toBe(true);
  });
});
