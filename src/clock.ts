import type { Session } from './types.js';
import type { Config } from './config.js';

const DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function nowET(d = new Date()): { ymd: string; hm: string; minutes: number; dow: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  }).formatToParts(d);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';
  // some ICU versions render midnight as '24' with hour12: false
  const hour = get('hour') === '24' ? '00' : get('hour');
  const minute = get('minute');
  return {
    ymd: `${get('year')}-${get('month')}-${get('day')}`,
    hm: `${hour}:${minute}`,
    minutes: Number(hour) * 60 + Number(minute),
    dow: DOW_NAMES.indexOf(get('weekday')),
  };
}

// Known v1 limitation: market holidays are treated as weekdays; the broker
// rejects orders those days.
export function currentSession(d = new Date()): Session {
  const { minutes, dow } = nowET(d);
  if (dow === 0 || dow === 6) return 'closed';
  if (minutes >= 240 && minutes < 570) return 'premarket'; // 04:00–09:30
  if (minutes >= 570 && minutes < 960) return 'rth'; // 09:30–16:00
  if (minutes >= 960 && minutes < 1200) return 'afterhours'; // 16:00–20:00
  return 'closed';
}

export function sessionEnabled(s: Session, cfg: Config): boolean {
  return (
    (s === 'premarket' && cfg.sessions.premarket) ||
    (s === 'afterhours' && cfg.sessions.afterhours) ||
    (s === 'rth' && cfg.sessions.regularhours)
  );
}
