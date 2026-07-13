import { describe, expect, it } from 'vitest';
import {
  candidatesFixture,
  configFixture,
  offhoursPlanFixture,
  verdictsFixture,
} from '../test/fixtures';
import { buildCandidateDecisionRows } from './candidates';

describe('buildCandidateDecisionRows', () => {
  it('uses recorded plan confidence for selected entries', () => {
    const rows = buildCandidateDecisionRows({
      candidates: candidatesFixture,
      verdicts: verdictsFixture,
      plan: offhoursPlanFixture,
      config: configFixture,
    });
    expect(rows.find((row) => row.symbol === 'AMD')).toMatchObject({
      panelPosition: 'long',
      agreeing: 2,
      requiredAgreeing: 2,
      confidence: 0.8,
      outcome: 'selected',
    });
  });

  it('does not reconstruct confidence for skipped candidates', () => {
    const rows = buildCandidateDecisionRows({
      candidates: candidatesFixture,
      verdicts: verdictsFixture,
      plan: offhoursPlanFixture,
      config: configFixture,
    });
    expect(rows.find((row) => row.symbol === 'WBD')).toMatchObject({
      panelPosition: 'long',
      agreeing: 1,
      confidence: null,
      confidenceText: 'Not recorded',
      outcome: 'not-selected',
      outcomeText: 'Not selected — 1 of 2 required analysts agreed.',
    });
  });
});
