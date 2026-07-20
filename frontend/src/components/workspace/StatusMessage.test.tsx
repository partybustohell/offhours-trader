import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatusMessage } from './StatusMessage';

describe('StatusMessage', () => {
  it('announces errors assertively and includes visible text', () => {
    render(
      <StatusMessage tone="error" announce="assertive">
        Refresh failed. Showing last-known data.
      </StatusMessage>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Refresh failed. Showing last-known data.',
    );
  });

  it('does not create a live region when announcement is off', () => {
    render(<StatusMessage tone="empty">No open positions.</StatusMessage>);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByText('No open positions.')).toBeVisible();
  });
});
