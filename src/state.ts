import type { HaltState } from './types.js';
import { statePath, writeJsonAtomic, readJsonIfExists } from './paths.js';

const DEFAULT_STATE: HaltState = { halted: false, reason: '', at: '' };

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
