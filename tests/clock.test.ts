import { describe, expect, it } from 'vitest';
import { nowET, currentSession, sessionEnabled } from '../src/clock.js';
import { ConfigSchema } from '../src/config.js';

// July fixtures are EDT (UTC-4); January fixtures are EST (UTC-5).
// 2026-07-06 and 2026-01-05 are both Mondays.

describe('nowET', () => {
  it('maps a July UTC instant to EDT fields (17:00 ET = 21:00Z)', () => {
    const t = nowET(new Date('2026-07-06T21:00:00Z'));
    expect(t).toEqual({ ymd: '2026-07-06', hm: '17:00', minutes: 1020, dow: 1 });
  });

  it('maps a January UTC instant to EST fields (17:00 ET = 22:00Z)', () => {
    const t = nowET(new Date('2026-01-05T22:00:00Z'));
    expect(t).toEqual({ ymd: '2026-01-05', hm: '17:00', minutes: 1020, dow: 1 });
  });

  it('handles midnight ET without a 24-hour artifact', () => {
    const t = nowET(new Date('2026-07-06T04:00:00Z'));
    expect(t).toEqual({ ymd: '2026-07-06', hm: '00:00', minutes: 0, dow: 1 });
  });

  it('keeps the ET calendar date when UTC has rolled over', () => {
    // 00:30Z July 7 is 20:30 ET July 6
    const t = nowET(new Date('2026-07-07T00:30:00Z'));
    expect(t.ymd).toBe('2026-07-06');
    expect(t.hm).toBe('20:30');
  });
});

describe('currentSession boundaries (July, EDT: ET = UTC-4)', () => {
  const cases: [string, string][] = [
    ['2026-07-06T07:59:00Z', 'closed'], // 03:59 ET
    ['2026-07-06T08:00:00Z', 'premarket'], // 04:00 ET
    ['2026-07-06T13:29:00Z', 'premarket'], // 09:29 ET
    ['2026-07-06T13:30:00Z', 'rth'], // 09:30 ET
    ['2026-07-06T19:59:00Z', 'rth'], // 15:59 ET
    ['2026-07-06T20:00:00Z', 'afterhours'], // 16:00 ET
    ['2026-07-06T23:59:00Z', 'afterhours'], // 19:59 ET
    ['2026-07-07T00:00:00Z', 'closed'], // 20:00 ET July 6
  ];
  for (const [iso, expected] of cases) {
    it(`${iso} -> ${expected}`, () => {
      expect(currentSession(new Date(iso))).toBe(expected);
    });
  }
});

describe('currentSession DST handling (January, EST: ET = UTC-5)', () => {
  it('04:00 ET (09:00Z) is premarket', () => {
    expect(currentSession(new Date('2026-01-05T09:00:00Z'))).toBe('premarket');
  });

  it('17:00 ET (22:00Z) is afterhours', () => {
    expect(currentSession(new Date('2026-01-05T22:00:00Z'))).toBe('afterhours');
  });

  it('the same UTC instant lands in different sessions across DST', () => {
    // 20:30Z: 15:30 ET in January (rth) vs 16:30 ET in July (afterhours)
    expect(currentSession(new Date('2026-01-05T20:30:00Z'))).toBe('rth');
    expect(currentSession(new Date('2026-07-06T20:30:00Z'))).toBe('afterhours');
  });
});

describe('currentSession weekends', () => {
  it('Saturday is closed even mid-day', () => {
    expect(currentSession(new Date('2026-07-11T14:00:00Z'))).toBe('closed'); // Sat 10:00 ET
  });

  it('Sunday is closed even mid-day', () => {
    expect(currentSession(new Date('2026-07-12T14:00:00Z'))).toBe('closed'); // Sun 10:00 ET
  });
});

describe('sessionEnabled', () => {
  const defaults = ConfigSchema.parse({});

  it('premarket and afterhours follow config, rth and closed are never enabled', () => {
    expect(sessionEnabled('premarket', defaults)).toBe(true);
    expect(sessionEnabled('afterhours', defaults)).toBe(true);
    expect(sessionEnabled('rth', defaults)).toBe(false);
    expect(sessionEnabled('closed', defaults)).toBe(false);
  });

  it('disabled sessions return false', () => {
    const cfg = ConfigSchema.parse({ sessions: { premarket: false, afterhours: false } });
    expect(sessionEnabled('premarket', cfg)).toBe(false);
    expect(sessionEnabled('afterhours', cfg)).toBe(false);
  });

  it('regularhours (rth) is gated by its own toggle', () => {
    const on = ConfigSchema.parse({ sessions: { regularhours: true } });
    expect(sessionEnabled('rth', on)).toBe(true);
    const off = ConfigSchema.parse({ sessions: { regularhours: false } });
    expect(sessionEnabled('rth', off)).toBe(false);
  });
});
