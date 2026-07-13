import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Pane } from './Pane';

describe('Pane', () => {
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
});
