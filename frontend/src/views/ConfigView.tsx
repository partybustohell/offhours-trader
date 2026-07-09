import { useEffect, useState, type CSSProperties } from 'react';
import type { AppData } from '../App';
import type { AnalystName, Config } from '../types';
import { ANALYSTS } from '../types';
import { putConfig } from '../api';
import { Card } from '../ui';

interface Draft {
  nominations_per_agent: string;
  max_candidates: string;
  min_price: string;
  min_avg_dollar_volume: string;
  exclude: string[];
  premarket: boolean;
  afterhours: boolean;
  regularhours: boolean;
  data_feed: 'iex' | 'sip';
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
  target_vol_pct: string;
  max_position_loss_pct: string;
  max_quote_age_sec: string;
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
    data_feed: c.data_feed,
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
    target_vol_pct: String(c.target_vol_pct),
    max_position_loss_pct: String(c.max_position_loss_pct),
    max_quote_age_sec: String(c.max_quote_age_sec),
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
    data_feed: d.data_feed,
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
    target_vol_pct: Number(d.target_vol_pct),
    max_position_loss_pct: Number(d.max_position_loss_pct),
    max_quote_age_sec: Number(d.max_quote_age_sec),
    daily_loss_halt_pct: Number(d.daily_loss_halt_pct),
    executor_interval_min: Number(d.executor_interval_min),
    thesis_run_time_et: d.thesis_run_time_et,
    model: { analysts: d.model_analysts, synthesizer: d.model_synthesizer, executor: d.model_executor },
  };
}

function Num({
  label,
  k,
  d,
  set,
  step = '1',
}: {
  label: string;
  k: keyof Draft;
  d: Draft;
  set: (p: Partial<Draft>) => void;
  step?: string;
}) {
  return (
    <div className="field">
      <label>{label}</label>
      <input
        type="number"
        step={step}
        value={d[k] as string}
        onChange={(e) => set({ [k]: e.target.value } as Partial<Draft>)}
      />
    </div>
  );
}

export default function ConfigView({ d: app, onSaved }: { d: AppData; onSaved: () => void }) {
  const config = app.config;
  const [d, setD] = useState<Draft | null>(config ? toDraft(config) : null);
  const [tag, setTag] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (config) setD(toDraft(config));
  }, [config]);

  if (!config || !d) {
    return (
      <div className="stagger">
        <div className="view-head" style={{ ['--i' as string]: 0 }}>
          <h1 className="view-title">Config</h1>
        </div>
        <Card>
          <p className="empty">Loading config…</p>
        </Card>
      </div>
    );
  }

  const set = (p: Partial<Draft>) => setD((prev) => (prev ? { ...prev, ...p } : prev));

  const save = async () => {
    setMsg(null);
    const r = await putConfig(toPayload(d, config));
    setMsg(r.ok ? { ok: true, text: 'Saved' } : { ok: false, text: r.error ?? 'Save failed' });
    if (r.ok) onSaved();
  };

  const addTag = () => {
    const v = tag.trim().toUpperCase();
    if (v && !d.exclude.includes(v)) set({ exclude: [...d.exclude, v] });
    setTag('');
  };

  const st = (i: number) => ({ ['--i' as string]: i }) as CSSProperties;

  return (
    <div className="stagger">
      <div className="view-head" style={st(0)}>
        <h1 className="view-title">Config</h1>
        <p className="view-desc">
          Every tunable knob. <b>mode</b> and <b>live acknowledgment</b> are read-only here — those
          change only by editing config.yaml by hand.
        </p>
      </div>

      <Card style={st(1)} title="System" flush>
        <div className="card-body" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className={`badge ${config.mode}`}>{config.mode}</span>
          <span className="badge">live ack: {String(config.live_trading_acknowledged)}</span>
          <span className="note">mode &amp; ack are edited in config.yaml by hand</span>
        </div>
      </Card>

      <Card style={st(2)} title="Universe" className="section-gap">
        <div className="field-grid">
          <Num label="nominations / agent" k="nominations_per_agent" d={d} set={set} />
          <Num label="max candidates" k="max_candidates" d={d} set={set} />
          <Num label="min price" k="min_price" d={d} set={set} step="0.5" />
          <Num label="min avg $ volume" k="min_avg_dollar_volume" d={d} set={set} step="1000000" />
        </div>
        <div className="field section-gap">
          <label>exclude (never trade)</label>
          <div className="tag-input">
            {d.exclude.map((t) => (
              <span key={t} className="tag">
                {t}
                <button className="tag-x" onClick={() => set({ exclude: d.exclude.filter((x) => x !== t) })}>
                  ×
                </button>
              </span>
            ))}
            <input
              type="text"
              value={tag}
              placeholder="add ticker, Enter"
              onChange={(e) => setTag(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addTag()}
            />
          </div>
        </div>
      </Card>

      <Card style={st(3)} title="Sessions & feed" className="section-gap">
        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'center' }}>
          <label className="check">
            <input type="checkbox" checked={d.premarket} onChange={(e) => set({ premarket: e.target.checked })} />
            premarket
          </label>
          <label className="check">
            <input type="checkbox" checked={d.afterhours} onChange={(e) => set({ afterhours: e.target.checked })} />
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
          <div className="field" style={{ minWidth: 120 }}>
            <label>data feed</label>
            <select
              value={d.data_feed}
              onChange={(e) => set({ data_feed: e.target.value as 'iex' | 'sip' })}
              style={{
                background: 'var(--bg-2)',
                border: '1px solid var(--line)',
                borderRadius: 3,
                color: 'var(--text)',
                fontFamily: 'var(--font-mono)',
                fontSize: 12,
                padding: '6px 9px',
              }}
            >
              <option value="iex">iex (free)</option>
              <option value="sip">sip (paid)</option>
            </select>
          </div>
        </div>
        <p className="note section-gap">
          iex is blind in deep off-hours but fully covers 09:30–16:00; sip (paid) is required to trade
          extended hours.
        </p>
      </Card>

      <Card style={st(4)} title="Agent weights" className="section-gap">
        <div className="sliders">
          {ANALYSTS.map((a) => (
            <div className="slider-row" key={a}>
              <span className="label">{a}</span>
              <input
                type="range"
                min={0}
                max={2}
                step={0.1}
                value={d.weights[a]}
                onChange={(e) => set({ weights: { ...d.weights, [a]: Number(e.target.value) } })}
              />
              <span className="v">{d.weights[a].toFixed(1)}</span>
            </div>
          ))}
        </div>
      </Card>

      <Card style={st(5)} title="Thesis & risk" className="section-gap">
        <div className="field-grid">
          <Num label="conviction threshold" k="conviction_threshold" d={d} set={set} step="0.01" />
          <Num label="quorum" k="quorum" d={d} set={set} />
          <Num label="min agreeing" k="min_agreeing" d={d} set={set} />
          <Num label="max position %" k="max_position_pct" d={d} set={set} />
          <Num label="max daily deploy %" k="max_daily_deploy_pct" d={d} set={set} />
          <Num label="max order notional $" k="max_order_notional_usd" d={d} set={set} step="100" />
          <Num label="max spread bps" k="max_spread_bps" d={d} set={set} />
          <Num label="max chase %" k="max_chase_pct" d={d} set={set} step="0.5" />
          <Num label="max drop %" k="max_drop_pct" d={d} set={set} step="0.5" />
          <Num label="target vol %" k="target_vol_pct" d={d} set={set} />
          <Num label="max position loss %" k="max_position_loss_pct" d={d} set={set} />
          <Num label="max quote age sec" k="max_quote_age_sec" d={d} set={set} step="10" />
          <Num label="daily loss halt %" k="daily_loss_halt_pct" d={d} set={set} />
          <Num label="executor interval min" k="executor_interval_min" d={d} set={set} />
        </div>
      </Card>

      <Card style={st(6)} title="Models" className="section-gap">
        <div className="field-grid">
          {(['model_analysts', 'model_synthesizer', 'model_executor'] as const).map((k) => (
            <div className="field" key={k}>
              <label>{k.replace('model_', '')}</label>
              <input type="text" value={d[k]} onChange={(e) => set({ [k]: e.target.value } as Partial<Draft>)} />
            </div>
          ))}
        </div>
      </Card>

      <div className="form-actions" style={st(7)}>
        <button className="btn primary" onClick={() => void save()}>
          Save config
        </button>
        {msg ? <span className={msg.ok ? 'ok' : 'err'}>{msg.text}</span> : null}
      </div>
    </div>
  );
}
