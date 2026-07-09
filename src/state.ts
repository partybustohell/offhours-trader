import type { HaltState } from './types.js';
import { peakPath, statePath, writeJsonAtomic, readJsonIfExists } from './paths.js';

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
