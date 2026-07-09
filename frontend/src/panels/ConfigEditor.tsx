import { useEffect, useState } from 'react';
import type { AnalystName, Config } from '../types';
import { ANALYSTS } from '../types';
import { putConfig } from '../api';

// Numeric fields are edited as strings so the inputs can be cleared while
// typing; conversion happens on save and the server-side schema rejects junk.
interface Draft {
  nominations_per_agent: string;
  max_candidates: string;
  min_price: string;
  min_avg_dollar_volume: string;
  exclude: string[];
  premarket: boolean;
  afterhours: boolean;
  regularhours: boolean;
  weights: Record<AnalystName, number>;
  conviction_threshold: string;
  quorum: string;
  min_agreeing: string;
  max_position_pct: string;
  max_daily_deploy_pct: string;
  max_order_notional_usd: string;
  max_spread_bps: string;
  max_chase_pct: string;
  max_drop_pct: string;
  daily_loss_halt_pct: string;
  executor_interval_min: string;
  thesis_run_time_et: string;
  model_analysts: string;
  model_synthesizer: string;
  model_executor: string;
}

function toDraft(c: Config): Draft {
  return {
    nominations_per_agent: String(c.universe.nominations_per_agent),
    max_candidates: String(c.universe.max_candidates),
    min_price: String(c.universe.min_price),
    min_avg_dollar_volume: String(c.universe.min_avg_dollar_volume),
    exclude: [...c.universe.exclude],
    premarket: c.sessions.premarket,
    afterhours: c.sessions.afterhours,
    regularhours: c.sessions.regularhours,
    weights: { ...c.agent_weights },
    conviction_threshold: String(c.conviction_threshold),
    quorum: String(c.quorum),
    min_agreeing: String(c.min_agreeing),
    max_position_pct: String(c.max_position_pct),
    max_daily_deploy_pct: String(c.max_daily_deploy_pct),
    max_order_notional_usd: String(c.max_order_notional_usd),
    max_spread_bps: String(c.max_spread_bps),
    max_chase_pct: String(c.max_chase_pct),
    max_drop_pct: String(c.max_drop_pct),
    daily_loss_halt_pct: String(c.daily_loss_halt_pct),
    executor_interval_min: String(c.executor_interval_min),
    thesis_run_time_et: c.thesis_run_time_et,
    model_analysts: c.model.analysts,
    model_synthesizer: c.model.synthesizer,
    model_executor: c.model.executor,
  };
}

function toPayload(d: Draft, c: Config): Record<string, unknown> {
  return {
    // mode and live_trading_acknowledged are echoed back unchanged; the server
    // forces them to on-disk values regardless.
    mode: c.mode,
    live_trading_acknowledged: c.live_trading_acknowledged,
    universe: {
      nominations_per_agent: Number(d.nominations_per_agent),
      max_candidates: Number(d.max_candidates),
      min_price: Number(d.min_price),
      min_avg_dollar_volume: Number(d.min_avg_dollar_volume),
      exclude: d.exclude,
    },
    sessions: { premarket: d.premarket, afterhours: d.afterhours, regularhours: d.regularhours },
    agent_weights: d.weights,
    conviction_threshold: Number(d.conviction_threshold),
    quorum: Number(d.quorum),
    min_agreeing: Number(d.min_agreeing),
    max_position_pct: Number(d.max_position_pct),
    max_daily_deploy_pct: Number(d.max_daily_deploy_pct),
    max_order_notional_usd: Number(d.max_order_notional_usd),
    max_spread_bps: Number(d.max_spread_bps),
    max_chase_pct: Number(d.max_chase_pct),
    max_drop_pct: Number(d.max_drop_pct),
    daily_loss_halt_pct: Number(d.daily_loss_halt_pct),
    executor_interval_min: Number(d.executor_interval_min),
    thesis_run_time_et: d.thesis_run_time_et,
    model: {
      analysts: d.model_analysts,
      synthesizer: d.model_synthesizer,
      executor: d.model_executor,
    },
  };
}

function Num({
  label,
  value,
  onChange,
  step = 'any',
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  step?: string;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <input type="number" step={step} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function Text({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <input type="text" value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

interface Props {
  config: Config | null;
  onSaved: () => void;
}

export default function ConfigEditor({ config, onSaved }: Props) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [tagText, setTagText] = useState('');

  // Polling refreshes config every 10s; only sync the form when there are no
  // unsaved edits so typing is not clobbered.
  useEffect(() => {
    if (config && !dirty) setDraft(toDraft(config));
  }, [config, dirty]);

  async function save() {
    if (!draft || !config || saving) return;
    setSaving(true);
    setNote(null);
    const res = await putConfig(toPayload(draft, config));
    setSaving(false);
    if (res.ok) {
      setDirty(false);
      setNote({ ok: true, text: 'Saved. Takes effect on the next run/tick.' });
      onSaved();
    } else {
      setNote({ ok: false, text: res.error ?? 'Save failed.' });
    }
  }

  if (!config || !draft) {
    return (
      <section className="panel">
        <h2>Config</h2>
        <p className="empty">Config not loaded.</p>
      </section>
    );
  }
  const cfg = config;
  const d = draft;

  const set = (patch: Partial<Draft>) => {
    setDraft({ ...d, ...patch });
    setDirty(true);
    setNote(null);
  };

  const addTag = () => {
    const t = tagText.trim().toUpperCase();
    setTagText('');
    if (!t) return;
    if (!d.exclude.includes(t)) set({ exclude: [...d.exclude, t] });
  };

  return (
    <section className="panel">
      <h2>Config</h2>

      <div className="cfg-locked">
        <span className={`badge mode-${cfg.mode}`}>{cfg.mode.toUpperCase()}</span>
        <span className="badge badge-gray">
          live ack: {cfg.live_trading_acknowledged ? 'true' : 'false'}
        </span>
        <span className="cfg-locked-note">
          mode and live_trading_acknowledged are read-only here — edit config.yaml by hand
        </span>
      </div>

      <h3>Universe</h3>
      <div className="field-grid">
        <Num
          label="nominations_per_agent"
          value={d.nominations_per_agent}
          step="1"
          onChange={(v) => set({ nominations_per_agent: v })}
        />
        <Num
          label="max_candidates"
          value={d.max_candidates}
          step="1"
          onChange={(v) => set({ max_candidates: v })}
        />
        <Num label="min_price" value={d.min_price} onChange={(v) => set({ min_price: v })} />
        <Num
          label="min_avg_dollar_volume"
          value={d.min_avg_dollar_volume}
          onChange={(v) => set({ min_avg_dollar_volume: v })}
        />
      </div>
      <div className="field">
        <span className="field-label">exclude (never trade)</span>
        <div className="tag-input">
          {d.exclude.map((t) => (
            <span className="tag tag-removable" key={t}>
              {t}
              <button
                type="button"
                className="tag-x"
                aria-label={`remove ${t}`}
                onClick={() => set({ exclude: d.exclude.filter((x) => x !== t) })}
              >
                ×
              </button>
            </span>
          ))}
          <input
            type="text"
            placeholder="add ticker, press Enter"
            value={tagText}
            onChange={(e) => setTagText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                addTag();
              }
            }}
            onBlur={addTag}
          />
        </div>
      </div>

      <h3>Sessions</h3>
      <div className="field-row">
        <label className="check">
          <input
            type="checkbox"
            checked={d.premarket}
            onChange={(e) => set({ premarket: e.target.checked })}
          />
          premarket
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={d.afterhours}
            onChange={(e) => set({ afterhours: e.target.checked })}
          />
          afterhours
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={d.regularhours}
            onChange={(e) => set({ regularhours: e.target.checked })}
          />
          regularhours
        </label>
      </div>

      <h3>Agent weights</h3>
      <div className="sliders">
        {ANALYSTS.map((a) => (
          <label className="field field-slider" key={a}>
            <span className="field-label">{a}</span>
            <input
              type="range"
              min={0}
              max={2}
              step={0.05}
              value={d.weights[a]}
              onChange={(e) => set({ weights: { ...d.weights, [a]: Number(e.target.value) } })}
            />
            <span className="weight-val">{d.weights[a].toFixed(2)}</span>
          </label>
        ))}
      </div>

      <h3>Thesis</h3>
      <div className="field-grid">
        <Num
          label="conviction_threshold"
          value={d.conviction_threshold}
          step="0.01"
          onChange={(v) => set({ conviction_threshold: v })}
        />
        <Num label="quorum" value={d.quorum} step="1" onChange={(v) => set({ quorum: v })} />
        <Num label="min_agreeing" value={d.min_agreeing} step="1" onChange={(v) => set({ min_agreeing: v })} />
        <Text
          label="thesis_run_time_et"
          value={d.thesis_run_time_et}
          onChange={(v) => set({ thesis_run_time_et: v })}
        />
      </div>

      <h3>Risk caps</h3>
      <div className="field-grid">
        <Num
          label="max_position_pct"
          value={d.max_position_pct}
          onChange={(v) => set({ max_position_pct: v })}
        />
        <Num
          label="max_daily_deploy_pct"
          value={d.max_daily_deploy_pct}
          onChange={(v) => set({ max_daily_deploy_pct: v })}
        />
        <Num
          label="max_order_notional_usd"
          value={d.max_order_notional_usd}
          onChange={(v) => set({ max_order_notional_usd: v })}
        />
        <Num
          label="max_spread_bps"
          value={d.max_spread_bps}
          onChange={(v) => set({ max_spread_bps: v })}
        />
        <Num
          label="max_chase_pct"
          value={d.max_chase_pct}
          onChange={(v) => set({ max_chase_pct: v })}
        />
        <Num
          label="max_drop_pct"
          value={d.max_drop_pct}
          onChange={(v) => set({ max_drop_pct: v })}
        />
        <Num
          label="daily_loss_halt_pct"
          value={d.daily_loss_halt_pct}
          onChange={(v) => set({ daily_loss_halt_pct: v })}
        />
        <Num
          label="executor_interval_min"
          value={d.executor_interval_min}
          step="1"
          onChange={(v) => set({ executor_interval_min: v })}
        />
      </div>

      <h3>Models</h3>
      <div className="field-grid">
        <Text
          label="analysts"
          value={d.model_analysts}
          onChange={(v) => set({ model_analysts: v })}
        />
        <Text
          label="synthesizer"
          value={d.model_synthesizer}
          onChange={(v) => set({ model_synthesizer: v })}
        />
        <Text
          label="executor"
          value={d.model_executor}
          onChange={(v) => set({ model_executor: v })}
        />
      </div>

      <div className="cfg-actions">
        <button className="btn btn-primary" disabled={!dirty || saving} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        {dirty ? (
          <button
            className="btn"
            onClick={() => {
              setDraft(toDraft(cfg));
              setDirty(false);
              setNote(null);
            }}
          >
            Revert
          </button>
        ) : null}
        {note ? <span className={note.ok ? 'note-ok' : 'note-err'}>{note.text}</span> : null}
      </div>
    </section>
  );
}
