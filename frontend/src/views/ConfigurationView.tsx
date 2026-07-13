import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ApiResult } from '../api';
import { Pane } from '../components/workspace/Pane';
import { StatusMessage } from '../components/workspace/StatusMessage';
import { sentenceCase } from '../presentation/format';
import { ANALYSTS, type Config } from '../types';
import {
  type ConfigDraft,
  type ConfigDraftFieldErrors,
  type ConfigDraftNumericField,
} from './config/configDraft';
import { useConfigDraft } from './config/useConfigDraft';

export interface ConfigurationViewProps {
  config: Config | null;
  onSave(next: Config): Promise<ApiResult<Config>>;
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="config-group">
      <h3>{title}</h3>
      <div className="config-fields">{children}</div>
    </section>
  );
}

function NumberField({
  label,
  errorName,
  value,
  errors,
  step = '1',
  min,
  max,
  onChange,
}: {
  label: string;
  errorName: ConfigDraftNumericField;
  value: string;
  errors: ConfigDraftFieldErrors;
  step?: string;
  min?: string;
  max?: string;
  onChange(value: string): void;
}) {
  const inputId = 'configuration-' + errorName.replace('.', '-');
  const errorId = inputId + '-error';
  const error = errors[errorName];

  return (
    <label className="field" htmlFor={inputId}>
      <span>{label}</span>
      <input
        id={inputId}
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      {error ? (
        <span id={errorId} className="field-error">{error}</span>
      ) : null}
    </label>
  );
}

function modeText(mode: Config['mode']): string {
  if (mode === 'dry-run') return 'Dry run';
  if (mode === 'paper') return 'Paper';
  return 'Live';
}

export function ConfigurationView({
  config,
  onSave,
}: ConfigurationViewProps) {
  const controller = useConfigDraft(config, onSave);
  const [exclude, setExclude] = useState('');
  const fieldsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (controller.validationAttempt === 0) return;
    fieldsRef.current
      ?.querySelector<HTMLElement>('[aria-invalid="true"]')
      ?.focus();
  }, [controller.validationAttempt]);

  const draft = controller.draft;
  if (!config || !draft) {
    return (
      <main className="route route--configuration">
        <Pane id="configuration" title="Configuration">
          <StatusMessage tone="loading" announce="polite">
            Loading configuration.
          </StatusMessage>
        </Pane>
      </main>
    );
  }

  const patchNumber = (
    name: Exclude<ConfigDraftNumericField, `weights.${string}`>,
    value: string,
  ) => {
    controller.patch({ [name]: value } as Partial<ConfigDraft>);
  };

  const addExclude = () => {
    const symbol = exclude.trim().toUpperCase();
    if (symbol && !draft.exclude.includes(symbol)) {
      controller.patch({ exclude: [...draft.exclude, symbol] });
    }
    setExclude('');
  };

  return (
    <main className="route route--configuration">
      <Pane
        id="configuration"
        title="Configuration"
        subtitle="Fields supported by this interface"
      >
        <div className="configuration" ref={fieldsRef}>
          <section className="config-readonly">
            <dl className="definition-rows">
              <div><dt>Mode</dt><dd>{modeText(config.mode)}</dd></div>
              <div>
                <dt>Live-trading acknowledgment</dt>
                <dd>
                  {config.live_trading_acknowledged
                    ? 'Acknowledged'
                    : 'Not acknowledged'}
                </dd>
              </div>
            </dl>
            <p>
              Mode and live-trading acknowledgment are read-only here. Change both in config.yaml.
            </p>
          </section>

          {controller.serverUpdateAvailable ? (
            <StatusMessage tone="stale" announce="polite">
              Newer server configuration is available. Your local edits have not been changed.
            </StatusMessage>
          ) : null}

          <Group title="Universe">
            <NumberField
              label="Nominations per analyst"
              errorName="nominations_per_agent"
              value={draft.nominations_per_agent}
              errors={controller.fieldErrors}
              onChange={(value) => patchNumber('nominations_per_agent', value)}
            />
            <NumberField
              label="Maximum candidates"
              errorName="max_candidates"
              value={draft.max_candidates}
              errors={controller.fieldErrors}
              onChange={(value) => patchNumber('max_candidates', value)}
            />
            <NumberField
              label="Minimum price"
              errorName="min_price"
              value={draft.min_price}
              errors={controller.fieldErrors}
              step="0.01"
              onChange={(value) => patchNumber('min_price', value)}
            />
            <NumberField
              label="Minimum average dollar volume"
              errorName="min_avg_dollar_volume"
              value={draft.min_avg_dollar_volume}
              errors={controller.fieldErrors}
              step="1000000"
              onChange={(value) => patchNumber('min_avg_dollar_volume', value)}
            />
            <div className="field field--wide">
              <span>Excluded symbols</span>
              <div className="exclude-list">
                {draft.exclude.map((symbol) => (
                  <span className="exclude-item" key={symbol}>
                    {symbol}
                    <button
                      type="button"
                      aria-label={'Remove ' + symbol}
                      onClick={() => controller.patch({
                        exclude: draft.exclude.filter((item) => item !== symbol),
                      })}
                    >
                      Remove
                    </button>
                  </span>
                ))}
              </div>
              <div className="field-inline">
                <input
                  aria-label="Symbol to exclude"
                  value={exclude}
                  onChange={(event) => setExclude(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      addExclude();
                    }
                  }}
                />
                <button type="button" onClick={addExclude}>Add symbol</button>
              </div>
            </div>
          </Group>

          <Group title="Sessions and data">
            {([
              ['premarket', 'Premarket'],
              ['afterhours', 'After-hours'],
              ['regularhours', 'Regular session'],
            ] as const).map(([name, label]) => (
              <label className="check-field" key={name}>
                <input
                  type="checkbox"
                  checked={draft[name]}
                  onChange={(event) => controller.patch({
                    [name]: event.target.checked,
                  } as Partial<ConfigDraft>)}
                />
                <span>{label}</span>
              </label>
            ))}
            <label className="field">
              <span>Data feed</span>
              <select
                value={draft.data_feed}
                onChange={(event) => controller.patch({
                  data_feed: event.target.value as 'iex' | 'sip',
                })}
              >
                <option value="iex">IEX</option>
                <option value="sip">SIP</option>
              </select>
            </label>
            <NumberField
              label="Maximum quote age (seconds)"
              errorName="max_quote_age_sec"
              value={draft.max_quote_age_sec}
              errors={controller.fieldErrors}
              onChange={(value) => patchNumber('max_quote_age_sec', value)}
            />
          </Group>

          <Group title="Analyst weights">
            {ANALYSTS.map((analyst) => (
              <NumberField
                key={analyst}
                label={sentenceCase(analyst)}
                errorName={`weights.${analyst}`}
                value={draft.weights[analyst]}
                errors={controller.fieldErrors}
                min="0"
                max="2"
                step="0.1"
                onChange={(value) => controller.patch({
                  weights: { ...draft.weights, [analyst]: value },
                })}
              />
            ))}
          </Group>

          <Group title="Decision rules">
            <NumberField
              label="Confidence threshold"
              errorName="conviction_threshold"
              value={draft.conviction_threshold}
              errors={controller.fieldErrors}
              step="0.01"
              onChange={(value) => patchNumber('conviction_threshold', value)}
            />
            <NumberField
              label="Required analyst count"
              errorName="quorum"
              value={draft.quorum}
              errors={controller.fieldErrors}
              onChange={(value) => patchNumber('quorum', value)}
            />
            <NumberField
              label="Minimum agreeing analysts"
              errorName="min_agreeing"
              value={draft.min_agreeing}
              errors={controller.fieldErrors}
              onChange={(value) => patchNumber('min_agreeing', value)}
            />
          </Group>

          <Group title="Risk limits">
            {([
              ['max_position_pct', 'Maximum position fraction', '0.01'],
              ['max_daily_deploy_pct', 'Maximum daily deployment fraction', '0.01'],
              ['max_order_notional_usd', 'Maximum order notional (USD)', '100'],
              ['max_spread_bps', 'Maximum spread (bps)', '1'],
              ['max_chase_pct', 'Maximum chase fraction', '0.01'],
              ['max_drop_pct', 'Maximum drop fraction', '0.01'],
              ['target_vol_pct', 'Target volatility fraction', '0.01'],
              ['max_position_loss_pct', 'Maximum position loss fraction', '0.01'],
              ['daily_loss_halt_pct', 'Daily loss halt fraction', '0.01'],
            ] as const).map(([name, label, step]) => (
              <NumberField
                key={name}
                label={label}
                errorName={name}
                value={draft[name]}
                errors={controller.fieldErrors}
                step={step}
                onChange={(value) => patchNumber(name, value)}
              />
            ))}
          </Group>

          <Group title="Execution">
            <NumberField
              label="Execution-check interval (minutes)"
              errorName="executor_interval_min"
              value={draft.executor_interval_min}
              errors={controller.fieldErrors}
              onChange={(value) => patchNumber('executor_interval_min', value)}
            />
            <label className="field">
              <span>Analysis run time (ET)</span>
              <input
                type="time"
                value={draft.thesis_run_time_et}
                onChange={(event) => controller.patch({
                  thesis_run_time_et: event.target.value,
                })}
              />
            </label>
          </Group>

          <Group title="Models">
            {([
              ['model_analysts', 'Analyst model'],
              ['model_synthesizer', 'Trading-plan model'],
              ['model_executor', 'Executor model'],
            ] as const).map(([name, label]) => (
              <label className="field" key={name}>
                <span>{label}</span>
                <input
                  type="text"
                  value={draft[name]}
                  onChange={(event) => controller.patch({
                    [name]: event.target.value,
                  } as Partial<ConfigDraft>)}
                />
              </label>
            ))}
          </Group>

          <div className="configuration__actions">
            <button
              type="button"
              onClick={controller.discard}
              disabled={
                controller.phase === 'clean'
                || controller.phase === 'loading'
                || controller.phase === 'saving'
              }
            >
              Discard local edits
            </button>
            <button
              type="button"
              className="is-primary"
              onClick={() => void controller.save()}
              disabled={
                controller.phase !== 'dirty'
                && controller.phase !== 'error'
              }
            >
              {controller.phase === 'saving'
                ? 'Saving…'
                : 'Save configuration'}
            </button>
          </div>
          {controller.phase === 'saved' && controller.message ? (
            <StatusMessage tone="success" announce="polite">
              {controller.message}
            </StatusMessage>
          ) : null}
          {controller.phase === 'error' && controller.message ? (
            <StatusMessage tone="error" announce="assertive">
              {controller.message}
            </StatusMessage>
          ) : null}
        </div>
      </Pane>
    </main>
  );
}
