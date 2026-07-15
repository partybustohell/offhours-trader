import type { HaltState } from './types.js';
import { peakPath, peaksPath, statePath, writeJsonAtomic, readJsonIfExists } from './paths.js';

const DEFAULT_STATE: HaltState = { halted: false, reason: '', at: '' };

interface PeakState {
  peakEquity: number;
  at: string;
}

/** High-water-mark equity (0 if never recorded or unreadable). */
export function readPeakEquity(): number {
  try {
    const raw = readJsonIfExists<PeakState>(peakPath());
    return raw && typeof raw.peakEquity === 'number' && raw.peakEquity > 0 ? raw.peakEquity : 0;
  } catch {
    return 0;
  }
}

/** Raise the high-water mark to `equity` if higher; returns the current peak. */
export function updatePeakEquity(equity: number, at: Date = new Date()): number {
  const prev = readPeakEquity();
  const peak = Math.max(prev, equity);
  if (peak > prev) writeJsonAtomic(peakPath(), { peakEquity: peak, at: at.toISOString() });
  return peak;
}

export function readHaltState(): HaltState {
  let raw: Partial<HaltState> | null;
  try {
    raw = readJsonIfExists<Partial<HaltState>>(statePath());
  } catch {
    return { ...DEFAULT_STATE };
  }
  if (!raw || typeof raw !== 'object' || typeof raw.halted !== 'boolean') {
    return { ...DEFAULT_STATE };
  }
  return {
    halted: raw.halted,
    reason: typeof raw.reason === 'string' ? raw.reason : '',
    at: typeof raw.at === 'string' ? raw.at : '',
  };
}

export function writeHalt(reason: string, at: Date = new Date()): HaltState {
  const state: HaltState = { halted: true, reason, at: at.toISOString() };
  writeJsonAtomic(statePath(), state);
  return state;
}

export function clearHalt(at: Date = new Date()): HaltState {
  const state: HaltState = { halted: false, reason: '', at: at.toISOString() };
  writeJsonAtomic(statePath(), state);
  return state;
}

export interface PositionPeak {
  side: 'long' | 'short';
  /** First tick that observed the position — conservative entry-time fallback
   *  (underestimates holding time, so a time stop can only fire LATER). */
  entryTimeMs: number;
  /** Favorable extreme since entry: high for longs, low for shorts. */
  peak: number;
}
type PeaksState = Record<string, PositionPeak>;

function readPeaks(): PeaksState {
  try {
    const raw = readJsonIfExists<PeaksState>(peaksPath());
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {}; // corrupt trailing state degrades to fresh, never blocks a tick
  }
}

/**
 * Read-update-write the favorable peak for one position at tick granularity
 * (the spec's fidelity rule: live and sim share this approximation). A side
 * flip or an unseen ticker starts a fresh record keyed to this tick's time.
 */
export function trackPositionPeak(
  ticker: string,
  side: 'long' | 'short',
  mark: number,
  nowMs: number,
): PositionPeak {
  const peaks = readPeaks();
  const key = ticker.toUpperCase();
  const prev = peaks[key];
  const rec: PositionPeak =
    prev && prev.side === side
      ? {
          side,
          entryTimeMs: prev.entryTimeMs,
          peak: side === 'long' ? Math.max(prev.peak, mark) : Math.min(prev.peak, mark),
        }
      : { side, entryTimeMs: nowMs, peak: mark };
  peaks[key] = rec;
  writeJsonAtomic(peaksPath(), peaks);
  return rec;
}

/** Drop peak records for tickers no longer held (position closed). */
export function prunePositionPeaks(openTickers: string[]): void {
  const peaks = readPeaks();
  const open = new Set(openTickers.map((t) => t.toUpperCase()));
  let changed = false;
  for (const key of Object.keys(peaks)) {
    if (!open.has(key)) {
      delete peaks[key];
      changed = true;
    }
  }
  if (changed) writeJsonAtomic(peaksPath(), peaks);
}
