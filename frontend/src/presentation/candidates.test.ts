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

  it('does not join a current candidate to yesterday verdicts or plan', () => {
    const rows = buildCandidateDecisionRows({
      candidates: { ...candidatesFixture, date: '2026-07-13' },
      verdicts: { ...verdictsFixture, date: '2026-07-12' },
      plan: { ...offhoursPlanFixture, date: '2026-07-12' },
      config: configFixture,
    });

    expect(rows.find((row) => row.symbol === 'AMD')).toMatchObject({
      panelPosition: 'none',
      agreeing: 0,
      confidence: null,
      outcome: 'pending',
      verdicts: [],
      entry: null,
      skipReason: null,
    });
  });

  it.each([
    {
      name: 'verdicts refresh before the plan',
      verdictDate: '2026-07-13',
      planDate: '2026-07-12',
      expectedPosition: 'long' as const,
      expectedVerdicts: 2,
      expectedOutcome: 'pending' as const,
    },
    {
      name: 'plan refresh before the verdicts',
      verdictDate: '2026-07-12',
      planDate: '2026-07-13',
      expectedPosition: 'long' as const,
      expectedVerdicts: 0,
      expectedOutcome: 'selected' as const,
    },
  ])('uses only decision evidence from the anchored date when $name', (testCase) => {
    const rows = buildCandidateDecisionRows({
      candidates: { ...candidatesFixture, date: '2026-07-13' },
      verdicts: { ...verdictsFixture, date: testCase.verdictDate },
      plan: { ...offhoursPlanFixture, date: testCase.planDate },
      config: configFixture,
    });

    expect(rows.find((row) => row.symbol === 'AMD')).toMatchObject({
      panelPosition: testCase.expectedPosition,
      verdicts: expect.any(Array),
      outcome: testCase.expectedOutcome,
    });
    expect(rows.find((row) => row.symbol === 'AMD')?.verdicts).toHaveLength(
      testCase.expectedVerdicts,
    );
  });

  it('does not treat missing dates as matching provenance', () => {
    const rows = buildCandidateDecisionRows({
      candidates: { ...candidatesFixture, date: '' },
      verdicts: { ...verdictsFixture, date: '' },
      plan: { ...offhoursPlanFixture, date: '' },
      config: configFixture,
    });

    expect(rows).toEqual([]);
  });
});
