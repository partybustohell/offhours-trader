import { describe, expect, it } from 'vitest';
import { configFixture } from '../../test/fixtures';
import {
  configDraftReducer,
  createConfigDraftState,
  toConfigDraft,
  toConfigPayload,
  validateConfigDraft,
} from './configDraft';

describe('configDraftReducer', () => {
  it('ignores an identical poll without marking server data newer', () => {
    const state = createConfigDraftState(configFixture);
    const next = configDraftReducer(state, {
      type: 'serverReceived',
      config: configFixture,
    });

    expect(next).toBe(state);
    expect(next.incoming).toBeNull();
  });

  it('adopts a changed poll while clean', () => {
    const state = createConfigDraftState(configFixture);
    const nextConfig = { ...configFixture, conviction_threshold: 0.75 };
    const next = configDraftReducer(state, {
      type: 'serverReceived',
      config: nextConfig,
    });

    expect(next.draft?.conviction_threshold).toBe('0.75');
    expect(next.phase).toBe('clean');
    expect(next.incoming).toBeNull();
  });

  it('preserves a dirty draft and retains newer server data separately', () => {
    const dirty = configDraftReducer(createConfigDraftState(configFixture), {
      type: 'patch',
      patch: { conviction_threshold: '0.82' },
    });
    const nextConfig = { ...configFixture, conviction_threshold: 0.75 };
    const next = configDraftReducer(dirty, {
      type: 'serverReceived',
      config: nextConfig,
    });

    expect(next.draft?.conviction_threshold).toBe('0.82');
    expect(next.incoming?.conviction_threshold).toBe(0.75);
  });

  it('clears a pending server update when polling returns to the baseline', () => {
    const dirty = configDraftReducer(createConfigDraftState(configFixture), {
      type: 'patch',
      patch: { conviction_threshold: '0.82' },
    });
    const withIncoming = configDraftReducer(dirty, {
      type: 'serverReceived',
      config: { ...configFixture, conviction_threshold: 0.75 },
    });
    const returnedToBaseline = configDraftReducer(withIncoming, {
      type: 'serverReceived',
      config: configFixture,
    });

    expect(returnedToBaseline.draft?.conviction_threshold).toBe('0.82');
    expect(returnedToBaseline.phase).toBe('dirty');
    expect(returnedToBaseline.incoming).toBeNull();
  });

  it('discards local edits into the newest server version', () => {
    const dirty = configDraftReducer(createConfigDraftState(configFixture), {
      type: 'patch',
      patch: { conviction_threshold: '0.82' },
    });
    const withIncoming = configDraftReducer(dirty, {
      type: 'serverReceived',
      config: { ...configFixture, conviction_threshold: 0.75 },
    });
    const discarded = configDraftReducer(withIncoming, { type: 'discard' });

    expect(discarded.draft?.conviction_threshold).toBe('0.75');
    expect(discarded.phase).toBe('clean');
  });

  it('builds a payload with latest read-only mode and acknowledgment', () => {
    const state = configDraftReducer(createConfigDraftState(configFixture), {
      type: 'patch',
      patch: { conviction_threshold: '0.82' },
    });
    const server = {
      ...configFixture,
      mode: 'dry-run' as const,
      live_trading_acknowledged: true,
    };

    expect(toConfigPayload(state.draft!, server)).toMatchObject({
      mode: 'dry-run',
      live_trading_acknowledged: true,
      conviction_threshold: 0.82,
    });
  });
});

describe('config draft numeric validation', () => {
  it.each([
    ['empty', ''],
    ['whitespace-only', '   '],
  ])('rejects an %s numeric string before payload construction', (_kind, value) => {
    const draft = {
      ...toConfigDraft(configFixture),
      conviction_threshold: value,
    };

    expect(validateConfigDraft(draft)).toMatchObject({
      conviction_threshold: 'Enter a numeric value.',
    });
    expect(() => toConfigPayload(draft, configFixture)).toThrow(
      'Configuration contains invalid numeric values.',
    );
  });

  it('keeps an empty analyst weight invalid instead of coercing it to zero', () => {
    const draft = toConfigDraft(configFixture);
    const withEmptyWeight = {
      ...draft,
      weights: { ...draft.weights, fundamental: '' },
    };

    expect(validateConfigDraft(withEmptyWeight)).toMatchObject({
      'weights.fundamental': 'Enter a numeric value.',
    });
    expect(() => toConfigPayload(withEmptyWeight, configFixture)).toThrow(
      'Configuration contains invalid numeric values.',
    );
  });
});
