import type { Session } from './types.js';
import type { Config } from './config.js';

// Session boundaries in ET minutes-since-midnight (mirror src/clock.ts):
//   premarket 04:00-09:30 = [240, 570)
//   rth       09:30-16:00 = [570, 960)
//   afterhours 16:00-20:00 = [960, 1200)
const RTH_OPEN_MIN = 570; // 09:30
const RTH_CLOSE_MIN = 960; // 16:00

/** Parse "HH:MM" (24h ET) to minutes since ET midnight. */
export function hmToMinutes(hm: string): number {
  const parts = hm.split(':');
  const h = Number(parts[0]);
  const m = Number(parts[1]);
  if (parts.length !== 2 || Number.isNaN(h) || Number.isNaN(m)) {
    throw new Error(`invalid HH:MM time: ${hm}`);
  }
  return h * 60 + m;
}

/**
 * Whether a NEW entry may be placed at this ET wall-clock minute. Purely a
 * function of the clock and config — no market data, so it behaves identically
 * on IEX and SIP. Blocks the RTH open/close windows (vol + spread spikes) and
 * the deep-premarket / late-afterhours liquidity vacuum. `closed` always
 * blocks. EXITS must never be gated by this — call it only on the entry path.
 */
export function entryTimingAllowed(session: Session, minutesET: number, cfg: Config): boolean {
  const b = cfg.entry_blackout;
  switch (session) {
    case 'rth': {
      const openEnd = RTH_OPEN_MIN + b.rth_open_min; // block [09:30, openEnd)
      const closeStart = RTH_CLOSE_MIN - b.rth_close_min; // block [closeStart, 16:00)
      return minutesET >= openEnd && minutesET < closeStart;
    }
    case 'premarket':
      return minutesET >= hmToMinutes(b.premarket_start_hm);
    case 'afterhours':
      return minutesET < hmToMinutes(b.afterhours_end_hm);
    default:
      return false; // 'closed' — nothing trades
  }
}

export interface SessionGate {
  maxSpreadBps: number;
  maxQuoteAgeSec: number;
  minTopSize: number;
}

/**
 * Pre-trade gate thresholds for a session. Session-calibrated values are
 * SIP-only: on the default IEX feed (or when the feature is off) they fall back
 * to the flat config values (today's behavior), so nothing tightens on IEX
 * where the top-of-book is fractional and refreshes slowly. `closed` uses flat.
 */
export function sessionGate(session: Session, cfg: Config): SessionGate {
  const flat: SessionGate = {
    maxSpreadBps: cfg.max_spread_bps,
    maxQuoteAgeSec: cfg.max_quote_age_sec,
    minTopSize: 1,
  };
  const g = cfg.execution.gates_by_session;
  if (!g.enabled || cfg.data_feed !== 'sip') return flat;
  const s = session === 'rth' ? g.rth : session === 'premarket' ? g.premarket : session === 'afterhours' ? g.afterhours : null;
  if (!s) return flat;
  return { maxSpreadBps: s.max_spread_bps, maxQuoteAgeSec: s.max_quote_age_sec, minTopSize: s.min_top_size };
}

export interface MacroEvent {
  date: string;
  hm: string;
  label: string;
}

/**
 * The scheduled macro event whose blackout window covers this ET instant, or
 * null. Window: [release - pre_min, release + post_min). Purely a function of
 * the ET clock and config — no market data, identical on IEX and SIP. ENTRIES
 * ONLY: exits must never be gated by this (same contract as entryTimingAllowed).
 * US macro releases all land well inside a single ET calendar day, so windows
 * never straddle midnight.
 */
export function activeEventBlackout(
  et: { ymd: string; minutes: number },
  cfg: Pick<Config, 'macro_event_blackout'>,
): MacroEvent | null {
  const b = cfg.macro_event_blackout;
  if (!b.enabled) return null;
  for (const ev of b.events) {
    if (ev.date !== et.ymd) continue;
    const t = hmToMinutes(ev.hm);
    if (et.minutes >= t - b.pre_min && et.minutes < t + b.post_min) return ev;
  }
  return null;
}
