import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  candidatesFixture,
  configFixture,
  offhoursPlanFixture,
  rthPlanFixture,
  verdictsFixture,
} from '../test/fixtures';
import { setViewport } from '../test/viewport';
import { ResearchView } from './ResearchView';

const props = {
  candidates: candidatesFixture,
  verdicts: verdictsFixture,
  offhoursPlan: offhoursPlanFixture,
  rthPlan: rthPlanFixture,
  config: configFixture,
};

const planWithMultipleSkips = {
  ...offhoursPlanFixture,
  skipped: [
    { ticker: 'WBD', reason: 'WBD stayed below the recorded agreement requirement.' },
    { ticker: 'WBD', reason: 'WBD stayed below the recorded agreement requirement.' },
    { ticker: 'GME', reason: 'GME was excluded by the recorded plan.' },
  ],
};

const rthPlanWithMultipleSkips = {
  ...planWithMultipleSkips,
  kind: 'rth' as const,
};

describe('ResearchView', () => {
  it('keeps one selected symbol across candidate and analyst information', async () => {
    render(<ResearchView {...props} />);
    await userEvent.click(screen.getByRole('row', { name: 'Inspect WBD research' }));
    expect(screen.getByRole('region', { name: 'Research detail' })).toHaveTextContent('WBD');
    expect(screen.getByRole('region', { name: 'Research detail' })).toHaveTextContent(
      '1 of 2 required analysts agreed.',
    );
    expect(screen.getByRole('table', { name: 'WBD analyst matrix' })).toBeVisible();
  });

  it('shows the exact filtered-out reason', async () => {
    render(<ResearchView {...props} />);
    await userEvent.click(screen.getByRole('tab', { name: 'Filtered out' }));
    expect(screen.getByText('Excluded by universe configuration.')).toBeVisible();
  });

  it('exposes off-hours and regular-session plans without calling them theses', () => {
    render(<ResearchView {...props} />);
    expect(screen.getByRole('tab', { name: 'Off-hours plan' })).toBeVisible();
    expect(screen.getByRole('tab', { name: 'Regular-session plan' })).toBeVisible();
    expect(screen.queryByText(/\bthesis\b/i)).not.toBeInTheDocument();
  });

  it('keeps plan-tab selection linked and shows the recorded plan detail', async () => {
    render(<ResearchView {...props} />);

    const matrix = screen.getByRole('table', { name: 'AMD analyst matrix' });
    expect(within(matrix).getAllByRole('row')).toHaveLength(6);

    await userEvent.click(screen.getByRole('tab', { name: 'Off-hours plan' }));
    expect(screen.getByRole('row', { name: 'Inspect AMD research' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByText('Trading plan').nextElementSibling).toHaveTextContent('Off-hours');
    expect(screen.getByText('Two recorded analyst views supported a long position.')).toBeVisible();

    await userEvent.click(screen.getByRole('tab', { name: 'Regular-session plan' }));
    expect(screen.getByRole('row', { name: 'Inspect AMD research' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByText('Trading plan').nextElementSibling).toHaveTextContent(
      'Regular session',
    );
  });

  it('uses config for the required analyst count without reconstructing skipped confidence', async () => {
    const { rerender } = render(<ResearchView {...props} />);
    await userEvent.click(screen.getByRole('row', { name: 'Inspect WBD research' }));

    const detail = screen.getByRole('region', { name: 'Research detail' });
    expect(
      within(detail).getByText('Required analyst count', { selector: 'dt' }).nextElementSibling,
    ).toHaveTextContent(/^2$/);
    expect(
      within(detail).getByText('Confidence', { selector: 'dt' }).nextElementSibling,
    ).toHaveTextContent(/^Not recorded$/);

    rerender(<ResearchView {...props} config={null} />);
    expect(
      within(detail).getByText('Required analyst count', { selector: 'dt' }).nextElementSibling,
    ).toHaveTextContent(/^Not recorded$/);
  });

  it('labels blank nomination and analyst evidence as not recorded', () => {
    const candidates = {
      ...candidatesFixture,
      candidates: candidatesFixture.candidates.map((candidate) =>
        candidate.ticker === 'AMD' ? { ...candidate, nominatedBy: [] } : candidate,
      ),
    };
    const verdicts = {
      ...verdictsFixture,
      verdicts: verdictsFixture.verdicts.map((verdict) =>
        verdict.ticker === 'AMD' && verdict.analyst === 'fundamental'
          ? { ...verdict, evidence: [] }
          : verdict,
      ),
    };
    render(<ResearchView {...props} candidates={candidates} verdicts={verdicts} />);

    const candidateRow = screen.getByRole('row', { name: 'Inspect AMD research' });
    expect(within(candidateRow).getByText('Not recorded')).toBeVisible();

    const nomination = screen.getByRole('heading', { name: 'Nomination' }).closest('section');
    expect(nomination).not.toBeNull();
    expect(within(nomination!).getByText('Not recorded')).toBeVisible();

    const matrix = screen.getByRole('table', { name: 'AMD analyst matrix' });
    const fundamentalRow = within(matrix).getByText('Fundamental').closest('tr');
    expect(fundamentalRow).not.toBeNull();
    expect(fundamentalRow).toHaveTextContent('Not recorded');
  });

  it('lists selected and skipped symbols once with outcomes in both plan tabs', async () => {
    render(
      <ResearchView
        {...props}
        candidates={null}
        verdicts={null}
        offhoursPlan={planWithMultipleSkips}
        rthPlan={rthPlanWithMultipleSkips}
      />,
    );

    for (const plan of [
      { tab: 'Off-hours plan', table: 'Off-hours trading plan' },
      { tab: 'Regular-session plan', table: 'Regular-session trading plan' },
    ]) {
      await userEvent.click(screen.getByRole('tab', { name: plan.tab }));
      const table = screen.getByRole('table', { name: plan.table });
      expect(within(table).getByRole('columnheader', { name: 'Outcome' })).toBeVisible();
      expect(within(table).getAllByRole('row')).toHaveLength(4);
      expect(
        within(table).getAllByRole('row', { name: 'Inspect WBD research' }),
      ).toHaveLength(1);
      expect(
        within(within(table).getByRole('row', { name: 'Inspect AMD research' }))
          .getByText('Selected'),
      ).toBeVisible();
      expect(
        within(within(table).getByRole('row', { name: 'Inspect WBD research' }))
          .getByText('Not selected'),
      ).toBeVisible();
      expect(
        within(within(table).getByRole('row', { name: 'Inspect GME research' }))
          .getByText('Not selected'),
      ).toBeVisible();
    }
  });

  it('makes every recorded skipped-plan reason reachable on mobile', async () => {
    setViewport(390, 844);
    const user = userEvent.setup();
    render(
      <ResearchView
        {...props}
        candidates={null}
        verdicts={null}
        offhoursPlan={planWithMultipleSkips}
        rthPlan={null}
      />,
    );
    await user.click(screen.getByRole('tab', { name: 'Off-hours plan' }));

    for (const skipped of [
      { symbol: 'WBD', reason: 'WBD stayed below the recorded agreement requirement.' },
      { symbol: 'GME', reason: 'GME was excluded by the recorded plan.' },
    ]) {
      await user.click(
        screen.getByRole('row', { name: 'Inspect ' + skipped.symbol + ' research' }),
      );
      expect(screen.getByRole('region', { name: 'Research detail' })).toHaveTextContent(
        skipped.reason,
      );
      await user.click(screen.getByRole('button', { name: 'Back to off-hours plan' }));
    }
  });

  it('uses the active mobile list in the visible Back label', async () => {
    setViewport(390, 844);
    const user = userEvent.setup();
    render(<ResearchView {...props} />);

    for (const context of [
      { tab: null, symbol: 'AMD', back: 'Back to candidates' },
      { tab: 'Filtered out', symbol: 'GME', back: 'Back to filtered out' },
      { tab: 'Off-hours plan', symbol: 'AMD', back: 'Back to off-hours plan' },
      { tab: 'Regular-session plan', symbol: 'AMD', back: 'Back to regular-session plan' },
    ]) {
      if (context.tab) {
        await user.click(screen.getByRole('tab', { name: context.tab }));
      }
      await user.click(
        screen.getByRole('row', { name: 'Inspect ' + context.symbol + ' research' }),
      );
      const back = screen.getByRole('button', { name: context.back });
      expect(back).toBeVisible();
      await user.click(back);
    }
  });

  it('filters trim-empty invalidation conditions and reports when none remain', () => {
    const withOneInvalidation = {
      ...offhoursPlanFixture,
      entries: offhoursPlanFixture.entries.map((entry) => ({
        ...entry,
        invalidationConditions: ['', '  Price closes below 170.  ', '   '],
      })),
    };
    const { rerender } = render(
      <ResearchView {...props} offhoursPlan={withOneInvalidation} />,
    );

    let invalidations = screen
      .getByRole('heading', { name: 'Invalidation conditions' })
      .closest('section');
    expect(invalidations).not.toBeNull();
    expect(within(invalidations!).getAllByRole('listitem')).toHaveLength(1);
    expect(within(invalidations!).getByText('Price closes below 170.')).toBeVisible();

    rerender(
      <ResearchView
        {...props}
        offhoursPlan={{
          ...withOneInvalidation,
          entries: withOneInvalidation.entries.map((entry) => ({
            ...entry,
            invalidationConditions: ['', '   '],
          })),
        }}
      />,
    );
    invalidations = screen
      .getByRole('heading', { name: 'Invalidation conditions' })
      .closest('section');
    expect(within(invalidations!).queryByRole('list')).not.toBeInTheDocument();
    expect(within(invalidations!).getByText('Not recorded')).toBeVisible();
  });

  it('moves keyboard focus to mobile detail and restores the Research row on close', async () => {
    setViewport(390, 844);
    const user = userEvent.setup();
    render(<ResearchView {...props} />);

    const row = screen.getByRole('row', { name: 'Inspect WBD research' });
    row.focus();
    await user.keyboard('{Enter}');

    const back = screen.getByRole('button', { name: 'Back to candidates' });
    expect(back).toHaveFocus();
    await user.click(back);
    expect(screen.getByRole('row', { name: 'Inspect WBD research' })).toHaveFocus();
  });
});
