import { describe, expect, it } from 'vitest';
import { ConfigSchema, type Config } from '../src/config.js';
import { activeEventBlackout, entryTimingAllowed, hmToMinutes, sessionGate } from '../src/session-risk.js';
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

describe('sessionGate (session-calibrated pre-trade gates; SIP-only)', () => {
  it('defaults to flat config values on the free IEX feed for every session', () => {
    const c = cfg(); // data_feed iex, gates_by_session disabled
    for (const s of ['rth', 'premarket', 'afterhours', 'closed'] as Session[]) {
      expect(sessionGate(s, c)).toEqual({ maxSpreadBps: c.max_spread_bps, maxQuoteAgeSec: c.max_quote_age_sec, minTopSize: 1 });
    }
  });

  it('stays flat even when gates are enabled if the feed is still IEX', () => {
    const c = cfg({ execution: { gates_by_session: { enabled: true } } });
    expect(sessionGate('rth', c)).toEqual({ maxSpreadBps: c.max_spread_bps, maxQuoteAgeSec: c.max_quote_age_sec, minTopSize: 1 });
  });

  it('applies tight session-specific values only on SIP with gates enabled', () => {
    const c = cfg({ data_feed: 'sip', execution: { gates_by_session: { enabled: true } } });
    expect(sessionGate('rth', c)).toEqual({ maxSpreadBps: 20, maxQuoteAgeSec: 20, minTopSize: 100 });
    expect(sessionGate('premarket', c)).toEqual({ maxSpreadBps: 80, maxQuoteAgeSec: 90, minTopSize: 100 });
    // closed session has no calibrated entry -> flat fallback
    expect(sessionGate('closed', c)).toEqual({ maxSpreadBps: c.max_spread_bps, maxQuoteAgeSec: c.max_quote_age_sec, minTopSize: 1 });
  });
});

describe('activeEventBlackout', () => {
  const eventCfg = ConfigSchema.parse({
    macro_event_blackout: {
      enabled: true,
      pre_min: 30,
      post_min: 15,
      events: [{ date: '2026-08-12', hm: '08:30', label: 'CPI' }],
    },
  });
  const minutes = (hm: string) => hmToMinutes(hm);

  it('blocks from pre_min before through post_min after the release', () => {
    expect(activeEventBlackout({ ymd: '2026-08-12', minutes: minutes('08:00') }, eventCfg)?.label).toBe('CPI');
    expect(activeEventBlackout({ ymd: '2026-08-12', minutes: minutes('08:30') }, eventCfg)?.label).toBe('CPI');
    expect(activeEventBlackout({ ymd: '2026-08-12', minutes: minutes('08:44') }, eventCfg)?.label).toBe('CPI');
  });

  it('is open just outside the window', () => {
    expect(activeEventBlackout({ ymd: '2026-08-12', minutes: minutes('07:59') }, eventCfg)).toBeNull();
    expect(activeEventBlackout({ ymd: '2026-08-12', minutes: minutes('08:45') }, eventCfg)).toBeNull();
  });

  it('ignores other dates, disabled gate, and an empty calendar', () => {
    expect(activeEventBlackout({ ymd: '2026-08-13', minutes: minutes('08:30') }, eventCfg)).toBeNull();
    const off = ConfigSchema.parse({
      macro_event_blackout: { enabled: false, events: [{ date: '2026-08-12', hm: '08:30', label: 'CPI' }] },
    });
    expect(activeEventBlackout({ ymd: '2026-08-12', minutes: minutes('08:30') }, off)).toBeNull();
    expect(activeEventBlackout({ ymd: '2026-08-12', minutes: minutes('08:30') }, ConfigSchema.parse({}))).toBeNull();
  });
});
