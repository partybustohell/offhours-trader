import type {
  CandidateFile,
  Config,
  Direction,
  Thesis,
  ThesisEntry,
  Verdict,
  VerdictFile,
} from '../types';
import { formatPercent } from './format';

export interface CandidateDecisionRow {
  symbol: string;
  panelPosition: Direction;
  agreeing: number;
  requiredAgreeing: number | null;
  confidence: number | null;
  requiredConfidence: number | null;
  confidenceText: string;
  outcome: 'selected' | 'not-selected' | 'pending';
  outcomeText: string;
  verdicts: readonly Verdict[];
  entry: ThesisEntry | null;
  skipReason: string | null;
}

function plurality(verdicts: readonly Verdict[]): Direction {
  const long = verdicts.filter((item) => item.direction === 'long').length;
  const short = verdicts.filter((item) => item.direction === 'short').length;
  if (long === short) return 'none';
  return long > short ? 'long' : 'short';
}

export function buildCandidateDecisionRows(input: {
  candidates: CandidateFile | null;
  verdicts: VerdictFile | null;
  plan: Thesis | null;
  config: Config | null;
}): CandidateDecisionRow[] {
  const symbols = new Set(input.candidates?.candidates.map((item) => item.ticker) ?? []);
  input.verdicts?.verdicts.forEach((verdict) => symbols.add(verdict.ticker));
  input.plan?.entries.forEach((entry) => symbols.add(entry.ticker));
  input.plan?.skipped.forEach((entry) => symbols.add(entry.ticker));

  return [...symbols].sort().map((symbol) => {
    const verdicts = input.verdicts?.verdicts.filter((item) => item.ticker === symbol) ?? [];
    const entry = input.plan?.entries.find((item) => item.ticker === symbol) ?? null;
    const skipped = input.plan?.skipped.find((item) => item.ticker === symbol) ?? null;
    const panelPosition = entry?.direction ?? plurality(verdicts);
    const agreeing = panelPosition === 'none'
      ? 0
      : verdicts.filter((item) => item.direction === panelPosition).length;
    const outcome = entry ? 'selected' : skipped ? 'not-selected' : 'pending';
    const outcomeText = entry
      ? 'Selected for the trading plan'
      : skipped
        ? 'Not selected — ' + skipped.reason
        : 'Decision pending';
    return {
      symbol,
      panelPosition,
      agreeing,
      requiredAgreeing: input.config?.min_agreeing ?? null,
      confidence: entry?.weightedConviction ?? null,
      requiredConfidence: input.config?.conviction_threshold ?? null,
      confidenceText: entry ? formatPercent(entry.weightedConviction) : 'Not recorded',
      outcome,
      outcomeText,
      verdicts,
      entry,
      skipReason: skipped?.reason ?? null,
    };
  });
}
