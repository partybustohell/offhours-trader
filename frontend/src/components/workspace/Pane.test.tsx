import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Pane } from './Pane';

describe('Pane', () => {
  it('places an untabbed body in the flexible row without inline overflow', () => {
    render(
      <Pane id="account" title="Account" overflow="hidden">
        Account detail
      </Pane>,
    );

    const region = screen.getByRole('region', { name: 'Account' });
    const body = region.querySelector('.pane__body');
    expect(body).toHaveClass('pane__body--overflow-hidden');
    expect(body).not.toHaveAttribute('style');
    expect(body).not.toHaveAttribute('role');
  });

  it('exposes a named region and accessible detail tabs', async () => {
    const onTabChange = vi.fn();
    render(
      <Pane
        id="candidate-detail"
        title="Candidate detail"
        tabs={[
          { id: 'summary', label: 'Summary' },
          { id: 'evidence', label: 'Evidence' },
          { id: 'rules', label: 'Rules' },
        ]}
        activeTab="summary"
        onTabChange={onTabChange}
      >
        Decision detail
      </Pane>,
    );

    expect(screen.getByRole('region', { name: 'Candidate detail' })).toBeVisible();
    expect(screen.getByRole('tab', { name: 'Summary' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await userEvent.click(screen.getByRole('tab', { name: 'Evidence' }));
    expect(onTabChange).toHaveBeenCalledWith('evidence');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Decision detail');
  });

  it('moves focus with wrapping arrow navigation', async () => {
    const onTabChange = vi.fn();
    render(
      <Pane
        id="candidate-detail"
        title="Candidate detail"
        tabs={[
          { id: 'summary', label: 'Summary' },
          { id: 'evidence', label: 'Evidence' },
          { id: 'rules', label: 'Rules' },
        ]}
        activeTab="summary"
        onTabChange={onTabChange}
      >
        Decision detail
      </Pane>,
    );

    const summaryTab = screen.getByRole('tab', { name: 'Summary' });
    const rulesTab = screen.getByRole('tab', { name: 'Rules' });
    summaryTab.focus();

    await userEvent.keyboard('{ArrowLeft}');
    expect(rulesTab).toHaveFocus();
    expect(onTabChange).toHaveBeenNthCalledWith(1, 'rules');

    await userEvent.keyboard('{ArrowRight}');
    expect(summaryTab).toHaveFocus();
    expect(onTabChange).toHaveBeenNthCalledWith(2, 'summary');
  });

  it('moves focus to the first and last tabs with Home and End', async () => {
    const onTabChange = vi.fn();
    render(
      <Pane
        id="candidate-detail"
        title="Candidate detail"
        tabs={[
          { id: 'summary', label: 'Summary' },
          { id: 'evidence', label: 'Evidence' },
          { id: 'rules', label: 'Rules' },
        ]}
        activeTab="evidence"
        onTabChange={onTabChange}
      >
        Decision detail
      </Pane>,
    );

    const summaryTab = screen.getByRole('tab', { name: 'Summary' });
    const evidenceTab = screen.getByRole('tab', { name: 'Evidence' });
    const rulesTab = screen.getByRole('tab', { name: 'Rules' });
    evidenceTab.focus();

    await userEvent.keyboard('{End}');
    expect(rulesTab).toHaveFocus();
    expect(onTabChange).toHaveBeenNthCalledWith(1, 'rules');

    await userEvent.keyboard('{Home}');
    expect(summaryTab).toHaveFocus();
    expect(onTabChange).toHaveBeenNthCalledWith(2, 'summary');
  });
});
