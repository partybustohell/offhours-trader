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
import { ResearchView } from './ResearchView';

const props = {
  candidates: candidatesFixture,
  verdicts: verdictsFixture,
  offhoursPlan: offhoursPlanFixture,
  rthPlan: rthPlanFixture,
  config: configFixture,
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
});
