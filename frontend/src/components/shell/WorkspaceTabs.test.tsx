import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ROUTES, type ViewId } from '../../router';
import { WorkspaceTabs } from './WorkspaceTabs';

describe('WorkspaceTabs', () => {
  it('preserves all six hashes and marks the active desktop and mobile routes', () => {
    render(
      <WorkspaceTabs routes={ROUTES} activeView="overview" onNavigate={vi.fn()} />,
    );

    const desktop = screen.getByRole('navigation', { name: 'Workspace routes' });
    expect(within(desktop).getAllByRole('link')).toHaveLength(6);
    expect(within(desktop).getByRole('link', { name: 'Monitor' })).toHaveAttribute(
      'href',
      '#/overview',
    );
    expect(within(desktop).getByRole('link', { name: 'Research' })).toHaveAttribute(
      'href',
      '#/thesis',
    );
    expect(within(desktop).getByRole('link', { name: 'Positions' })).toHaveAttribute(
      'href',
      '#/positions',
    );
    expect(within(desktop).getByRole('link', { name: 'Backtest' })).toHaveAttribute(
      'href',
      '#/backtest',
    );
    expect(within(desktop).getByRole('link', { name: 'Configuration' })).toHaveAttribute(
      'href',
      '#/config',
    );
    expect(within(desktop).getByRole('link', { name: 'Audit' })).toHaveAttribute(
      'href',
      '#/audit',
    );
    expect(within(desktop).getByRole('link', { name: 'Monitor' })).toHaveAttribute(
      'aria-current',
      'page',
    );

    const mobile = screen.getByRole('navigation', { name: 'Mobile workspace routes' });
    expect(within(mobile).getAllByRole('link')).toHaveLength(3);
    expect(within(mobile).getByRole('link', { name: 'Monitor' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('opens More as an ordinary disclosure and focuses the first secondary destination', async () => {
    const user = userEvent.setup();
    render(
      <WorkspaceTabs routes={ROUTES} activeView="overview" onNavigate={vi.fn()} />,
    );
    const mobile = screen.getByRole('navigation', { name: 'Mobile workspace routes' });
    const more = within(mobile).getByRole('button', { name: 'More routes' });

    expect(more).toHaveAttribute('aria-expanded', 'false');
    expect(more).toHaveAttribute('aria-controls', 'mobile-more-routes');
    await user.click(more);

    expect(more).toHaveAttribute('aria-expanded', 'true');
    const backtest = within(mobile).getByRole('link', { name: 'Backtest' });
    await waitFor(() => expect(backtest).toHaveFocus());
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument();
  });

  it('closes More on Escape and returns focus to its trigger', async () => {
    const user = userEvent.setup();
    render(
      <WorkspaceTabs routes={ROUTES} activeView="overview" onNavigate={vi.fn()} />,
    );
    const mobile = screen.getByRole('navigation', { name: 'Mobile workspace routes' });
    const more = within(mobile).getByRole('button', { name: 'More routes' });
    await user.click(more);
    await waitFor(() => {
      expect(within(mobile).getByRole('link', { name: 'Backtest' })).toHaveFocus();
    });

    await user.keyboard('{Escape}');

    expect(more).toHaveAttribute('aria-expanded', 'false');
    expect(within(mobile).queryByRole('link', { name: 'Backtest' })).not.toBeInTheDocument();
    expect(more).toHaveFocus();
  });

  it('reaches a secondary route and closes the disclosure after navigation', async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();

    function Harness() {
      const [activeView, setActiveView] = useState<ViewId>('overview');
      return (
        <WorkspaceTabs
          routes={ROUTES}
          activeView={activeView}
          onNavigate={(next) => {
            onNavigate(next);
            setActiveView(next);
          }}
        />
      );
    }

    render(<Harness />);
    const mobile = screen.getByRole('navigation', { name: 'Mobile workspace routes' });
    const more = within(mobile).getByRole('button', { name: 'More routes' });
    await user.click(more);

    await user.click(within(mobile).getByRole('link', { name: 'Audit' }));

    expect(onNavigate).toHaveBeenCalledWith('audit');
    const currentMore = within(mobile).getByRole('button', {
      name: 'More routes, current route Audit',
    });
    expect(currentMore).toHaveAttribute('aria-expanded', 'false');
    expect(within(mobile).queryByRole('link', { name: 'Audit' })).not.toBeInTheDocument();
    await waitFor(() => expect(currentMore).toHaveFocus());
  });

  it('closes an open disclosure when navigation happens elsewhere', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <WorkspaceTabs routes={ROUTES} activeView="overview" onNavigate={vi.fn()} />,
    );
    const mobile = screen.getByRole('navigation', { name: 'Mobile workspace routes' });
    await user.click(within(mobile).getByRole('button', { name: 'More routes' }));
    expect(within(mobile).getByRole('link', { name: 'Backtest' })).toBeVisible();

    rerender(<WorkspaceTabs routes={ROUTES} activeView="positions" onNavigate={vi.fn()} />);

    expect(within(mobile).getByRole('button', { name: 'More routes' }))
      .toHaveAttribute('aria-expanded', 'false');
    expect(within(mobile).queryByRole('link', { name: 'Backtest' })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(within(mobile).getByRole('button', { name: 'More routes' })).toHaveFocus();
    });
  });
});
