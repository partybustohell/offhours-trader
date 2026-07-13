import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { configFixture } from '../test/fixtures';
import { ConfigurationView } from './ConfigurationView';

describe('ConfigurationView', () => {
  it('protects a dirty field when newer server config arrives', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const { rerender } = render(
      <ConfigurationView config={configFixture} onSave={onSave} />,
    );
    const field = screen.getByLabelText('Confidence threshold');
    await user.clear(field);
    await user.type(field, '0.82');

    rerender(
      <ConfigurationView
        config={{ ...configFixture, conviction_threshold: 0.75 }}
        onSave={onSave}
      />,
    );

    expect(field).toHaveValue(0.82);
    expect(screen.getByText(
      'Newer server configuration is available. Your local edits have not been changed.',
    )).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Discard local edits' }));
    expect(field).toHaveValue(0.75);
  });

  it('withdraws a newer-server warning when polling returns to the baseline', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const { rerender } = render(
      <ConfigurationView config={configFixture} onSave={onSave} />,
    );
    const field = screen.getByLabelText('Confidence threshold');
    const warning =
      'Newer server configuration is available. Your local edits have not been changed.';
    await user.clear(field);
    await user.type(field, '0.82');

    rerender(
      <ConfigurationView
        config={{ ...configFixture, conviction_threshold: 0.75 }}
        onSave={onSave}
      />,
    );
    expect(screen.getByText(warning)).toBeVisible();

    rerender(
      <ConfigurationView config={configFixture} onSave={onSave} />,
    );

    await waitFor(() => expect(screen.queryByText(warning)).not.toBeInTheDocument());
    expect(field).toHaveValue(0.82);
  });

  it('submits the dirty draft and gives a truthful general backend next step', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue({
      ok: false,
      error: 'Confidence must be between 0 and 1.',
    });
    render(<ConfigurationView config={configFixture} onSave={onSave} />);
    const field = screen.getByLabelText('Confidence threshold');
    await user.clear(field);
    await user.type(field, '2');
    await user.click(screen.getByRole('button', { name: 'Save configuration' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Configuration was not saved. Confidence must be between 0 and 1. '
        + 'Review the values and try again.',
    );
    expect(field).toHaveValue(2);
    expect(field).not.toHaveAttribute('aria-invalid');
    expect(onSave).toHaveBeenCalledOnce();
  });

  it('blocks empty numeric fields and focuses the first associated error', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<ConfigurationView config={configFixture} onSave={onSave} />);
    const firstField = screen.getByLabelText('Nominations per analyst');
    const laterField = screen.getByLabelText('Confidence threshold');
    await user.clear(firstField);
    await user.clear(laterField);
    await user.click(screen.getByRole('button', { name: 'Save configuration' }));

    expect(onSave).not.toHaveBeenCalled();
    expect(firstField).toHaveAttribute('aria-invalid', 'true');
    expect(laterField).toHaveAttribute('aria-invalid', 'true');

    const firstErrorId = firstField.getAttribute('aria-describedby');
    const laterErrorId = laterField.getAttribute('aria-describedby');
    expect(firstErrorId).toBeTruthy();
    expect(laterErrorId).toBeTruthy();
    expect(firstErrorId).not.toBe(laterErrorId);
    expect(document.getElementById(firstErrorId!)).toHaveTextContent(
      'Enter a numeric value.',
    );
    expect(document.getElementById(firstErrorId!)).toBeVisible();
    expect(document.getElementById(laterErrorId!)).toHaveTextContent(
      'Enter a numeric value.',
    );
    await waitFor(() => expect(firstField).toHaveFocus());
  });

  it('keeps a cleared analyst weight invalid and blocks saving it as zero', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<ConfigurationView config={configFixture} onSave={onSave} />);
    const field = screen.getByLabelText('Fundamental');
    await user.clear(field);
    await user.click(screen.getByRole('button', { name: 'Save configuration' }));

    expect(field).toHaveValue(null);
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(onSave).not.toHaveBeenCalled();
    await waitFor(() => expect(field).toHaveFocus());
  });

  it('states that mode and acknowledgment are edited in config.yaml', () => {
    render(<ConfigurationView config={configFixture} onSave={vi.fn()} />);

    expect(screen.getByText(
      'Mode and live-trading acknowledgment are read-only here. Change both in config.yaml.',
    )).toBeVisible();
  });

  it('groups every supported field section', () => {
    render(<ConfigurationView config={configFixture} onSave={vi.fn()} />);

    for (const name of [
      'Universe',
      'Sessions and data',
      'Analyst weights',
      'Decision rules',
      'Risk limits',
      'Execution',
      'Models',
    ]) {
      expect(screen.getByRole('heading', { name })).toBeVisible();
    }
  });

  it('labels backend percentage-point risk values as percentages', () => {
    render(
      <ConfigurationView
        config={{
          ...configFixture,
          max_position_pct: 5,
          max_daily_deploy_pct: 10,
          max_chase_pct: 1,
          max_drop_pct: 3,
          target_vol_pct: 40,
          max_position_loss_pct: 8,
          daily_loss_halt_pct: 3,
        }}
        onSave={vi.fn()}
      />,
    );

    for (const [label, value] of [
      ['Maximum position percentage', 5],
      ['Maximum daily deployment percentage', 10],
      ['Maximum chase percentage', 1],
      ['Maximum drop percentage', 3],
      ['Target volatility percentage', 40],
      ['Maximum position loss percentage', 8],
      ['Daily loss halt percentage', 3],
    ] as const) {
      expect(screen.getByLabelText(label)).toHaveValue(value);
    }
    expect(screen.queryByText(/fraction/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Confidence threshold')).toHaveValue(0.7);
  });

  it('locks every editable control while a save is pending', async () => {
    const user = userEvent.setup();
    const saved = { ...configFixture, conviction_threshold: 0.82 };
    let resolveSave!: (result: { ok: true; data: typeof saved }) => void;
    const onSave = vi.fn(() => new Promise<{ ok: true; data: typeof saved }>((resolve) => {
      resolveSave = resolve;
    }));
    render(<ConfigurationView config={configFixture} onSave={onSave} />);
    const field = screen.getByLabelText('Confidence threshold');
    const saveButton = screen.getByRole('button', { name: 'Save configuration' });
    await user.clear(field);
    await user.type(field, '0.82');
    await user.click(saveButton);

    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    const controls = screen.getByRole('main').querySelectorAll(
      'input, select, button',
    );
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) expect(control).toBeDisabled();

    await user.click(field);
    await user.keyboard('9');
    await user.click(saveButton);
    expect(field).toHaveValue(0.82);
    expect(onSave).toHaveBeenCalledOnce();

    await act(async () => resolveSave({ ok: true, data: saved }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Configuration saved.',
    );
  });

  it('announces a successful save politely', async () => {
    const user = userEvent.setup();
    const saved = { ...configFixture, conviction_threshold: 0.82 };
    const onSave = vi.fn().mockResolvedValue({ ok: true, data: saved });
    render(<ConfigurationView config={configFixture} onSave={onSave} />);
    const field = screen.getByLabelText('Confidence threshold');
    await user.clear(field);
    await user.type(field, '0.82');
    await user.click(screen.getByRole('button', { name: 'Save configuration' }));

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Configuration saved.',
    );
  });
});
