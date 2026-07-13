import { createEvent, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { setViewport } from '../../test/viewport';
import { ResizableWorkspace, fitWidths } from './ResizableWorkspace';

const props = {
  storageKey: 'offhours.monitor.columns.v1',
  defaults: { left: 260, right: 360 },
  constraints: {
    left: [220, 360] as const,
    centerMin: 480,
    right: [300, 480] as const,
  },
  left: <div>Account</div>,
  center: <div>Candidates</div>,
  right: <div>Detail</div>,
  bottom: <div>Activity</div>,
};

describe('fitWidths', () => {
  it('fits the 1024px boundary without shrinking center below 480px', () => {
    expect(fitWidths(1024, props.defaults, props.constraints)).toEqual({
      left: 242,
      right: 300,
    });
  });
});

describe('ResizableWorkspace', () => {
  it('restores valid versioned storage and ignores malformed storage', () => {
    setViewport(1440, 900);
    localStorage.setItem(
      props.storageKey,
      JSON.stringify({ version: 1, left: 300, right: 420 }),
    );
    const { unmount } = render(<ResizableWorkspace {...props} />);
    expect(screen.getByRole('separator', { name: 'Resize account pane' })).toHaveAttribute(
      'aria-valuenow',
      '300',
    );
    unmount();

    localStorage.setItem(props.storageKey, '{"version":1,"left":"bad"}');
    render(<ResizableWorkspace {...props} />);
    expect(screen.getByRole('separator', { name: 'Resize account pane' })).toHaveAttribute(
      'aria-valuenow',
      '260',
    );
  });

  it('supports arrow resizing, persistence, and double-click reset', () => {
    setViewport(1440, 900);
    render(<ResizableWorkspace {...props} />);
    const separator = screen.getByRole('separator', { name: 'Resize account pane' });
    fireEvent.keyDown(separator, { key: 'ArrowRight' });
    expect(separator).toHaveAttribute('aria-valuenow', '270');
    expect(JSON.parse(localStorage.getItem(props.storageKey) ?? '{}')).toMatchObject({
      version: 1,
      left: 270,
    });

    fireEvent.doubleClick(separator);
    expect(separator).toHaveAttribute('aria-valuenow', '260');
    expect(localStorage.getItem(props.storageKey)).toBeNull();
  });

  it.each(['ArrowLeft', 'ArrowRight', 'Home', 'End'])(
    'prevents the browser default for handled %s resizing',
    (key) => {
      setViewport(1440, 900);
      render(<ResizableWorkspace {...props} />);
      const separator = screen.getByRole('separator', { name: 'Resize account pane' });
      const event = createEvent.keyDown(separator, { key, cancelable: true });

      fireEvent(separator, event);

      expect(event.defaultPrevented).toBe(true);
    },
  );

  it('hides inactive mobile panes from accessibility and focus', () => {
    setViewport(390, 844);
    const interactiveProps = {
      ...props,
      left: <button type="button">Account control</button>,
      center: <button type="button">Candidate rows</button>,
      right: <button type="button">Candidate detail</button>,
      bottom: <button type="button">Activity control</button>,
    };
    const { container, rerender } = render(
      <ResizableWorkspace {...interactiveProps} detailOpen={false} />,
    );

    expect(screen.getByRole('button', { name: 'Account control' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Candidate rows' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Activity control' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Candidate detail' })).not.toBeInTheDocument();
    expect(container.querySelector('.resizable-workspace__right')).toHaveAttribute('hidden');

    rerender(<ResizableWorkspace {...interactiveProps} detailOpen />);

    expect(screen.queryByRole('button', { name: 'Account control' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Candidate rows' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Activity control' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Candidate detail' })).toBeVisible();
    expect(container.querySelector('.resizable-workspace__left')).toHaveAttribute('hidden');
    expect(container.querySelector('.resizable-workspace__center')).toHaveAttribute('hidden');
    expect(container.querySelector('.resizable-workspace__bottom')).toHaveAttribute('hidden');
    expect(container.querySelector('.resizable-workspace__right')).not.toHaveAttribute('hidden');
  });

  it.each([false, true])(
    'keeps all compact panes visible at 900px when detailOpen is %s',
    (detailOpen) => {
      setViewport(900, 700);
      render(<ResizableWorkspace {...props} detailOpen={detailOpen} />);

      expect(screen.getByText('Account')).toBeVisible();
      expect(screen.getByText('Candidates')).toBeVisible();
      expect(screen.getByText('Detail')).toBeVisible();
      expect(screen.getByText('Activity')).toBeVisible();
    },
  );

  it.each([900, 1015])(
    'removes separators at %ipx below the 1016px three-column threshold',
    (width) => {
      setViewport(width, 700);
      render(<ResizableWorkspace {...props} />);

      expect(screen.queryByRole('separator')).not.toBeInTheDocument();
      expect(screen.getByTestId('resizable-workspace')).toHaveAttribute(
        'data-layout',
        'compact',
      );
    },
  );

  it('renders the three-column resize handles at 1016px', () => {
    setViewport(1016, 700);
    render(<ResizableWorkspace {...props} />);

    expect(screen.getAllByRole('separator')).toHaveLength(2);
    expect(screen.getByTestId('resizable-workspace')).toHaveAttribute(
      'data-layout',
      'wide',
    );
  });
});
