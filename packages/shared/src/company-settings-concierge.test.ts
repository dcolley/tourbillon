import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  parseCompanySettings,
  resolveConciergeModel,
  mergeCompanySettings,
} from './company-settings';

describe('CONCIERGE-MODEL-1 — parseCompanySettings conciergeModel', () => {
  it('parses a complete provider + model pair', () => {
    const parsed = parseCompanySettings({
      conciergeModel: { providerId: 'openrouter', modelId: 'openai/gpt-5.4-mini' },
    });
    assert.deepEqual(parsed.conciergeModel, {
      providerId: 'openrouter',
      modelId: 'openai/gpt-5.4-mini',
    });
  });

  it('drops blank and half-configured pairs', () => {
    assert.equal(
      parseCompanySettings({ conciergeModel: { providerId: '  ', modelId: 'x/y' } }).conciergeModel
        ?.providerId,
      undefined,
    );
    assert.equal(
      parseCompanySettings({ conciergeModel: { modelId: 'x/y' } }).conciergeModel?.providerId,
      undefined,
    );
    assert.equal(
      parseCompanySettings({ conciergeModel: { providerId: 'p' } }).conciergeModel?.modelId,
      undefined,
    );
    assert.equal(parseCompanySettings({}).conciergeModel, undefined);
    assert.equal(parseCompanySettings(null).conciergeModel, undefined);
  });
});

describe('CONCIERGE-MODEL-1 — resolveConciergeModel', () => {
  it('returns the pair only when fully configured', () => {
    assert.deepEqual(
      resolveConciergeModel({ conciergeModel: { providerId: 'p', modelId: 'm' } }),
      { providerId: 'p', modelId: 'm' },
    );
  });

  it('returns null for unset, whitespace or partial pairs', () => {
    assert.equal(resolveConciergeModel({ conciergeModel: { modelId: 'm' } }), null);
    assert.equal(resolveConciergeModel({ conciergeModel: { providerId: 'p' } }), null);
    assert.equal(resolveConciergeModel({ conciergeModel: { providerId: ' ', modelId: 'm' } }), null);
    assert.equal(resolveConciergeModel({}), null);
    assert.equal(resolveConciergeModel(null), null);
    assert.equal(resolveConciergeModel(undefined), null);
  });
});

describe('CONCIERGE-MODEL-1 — mergeCompanySettings conciergeModel', () => {
  it('replaces the stored pair', () => {
    const merged = mergeCompanySettings(
      { conciergeModel: { providerId: 'p1', modelId: 'm1' } },
      { conciergeModel: { providerId: 'p2', modelId: 'm2' } },
    );
    assert.deepEqual(merged.conciergeModel, { providerId: 'p2', modelId: 'm2' });
  });

  it('clears the pair with an empty patch object', () => {
    const merged = mergeCompanySettings(
      { conciergeModel: { providerId: 'p1', modelId: 'm1' } },
      { conciergeModel: {} },
    );
    assert.equal(merged.conciergeModel, undefined);
  });

  it('keeps unrelated settings keys when patching the pair', () => {
    const merged = mergeCompanySettings(
      { tavilyApiKey: 'tvly-SECRET', conciergeModel: { providerId: 'p1', modelId: 'm1' } },
      { conciergeModel: { providerId: 'p2', modelId: 'm2' } },
    );
    assert.equal(merged.tavilyApiKey, 'tvly-SECRET');
    assert.deepEqual(merged.conciergeModel, { providerId: 'p2', modelId: 'm2' });
  });
});

describe('CONCIERGE-PARAMS — model params (parse / merge / resolve)', () => {
  it('parse keeps valid params and drops malformed params', () => {
    const good = parseCompanySettings({
      conciergeModel: {
        providerId: 'prov-qwen',
        modelId: 'qwen/qwen3.6-35b-a3b',
        params: { maxContextTokens: 65_536, maxOutputTokens: 2_048 },
      },
    });
    assert.deepEqual(good.conciergeModel, {
      providerId: 'prov-qwen',
      modelId: 'qwen/qwen3.6-35b-a3b',
      params: { maxContextTokens: 65_536, maxOutputTokens: 2_048 },
    });

    // Tolerant read: garbage params never poison the pair — they are dropped.
    const malformed = parseCompanySettings({
      conciergeModel: { providerId: 'p', modelId: 'm', params: { maxContextTokens: 'nope' } },
    });
    assert.deepEqual(malformed.conciergeModel, { providerId: 'p', modelId: 'm' });
  });

  it('merge stores params and treats blank params as cleared', () => {
    const stored = mergeCompanySettings(
      {},
      { conciergeModel: { providerId: 'p', modelId: 'm', params: { maxContextTokens: 65_536 } } },
    );
    assert.deepEqual(stored.conciergeModel, {
      providerId: 'p',
      modelId: 'm',
      params: { maxContextTokens: 65_536 },
    });

    const clearedParams = mergeCompanySettings(stored, { conciergeModel: { providerId: 'p', modelId: 'm' } });
    assert.deepEqual(clearedParams.conciergeModel, { providerId: 'p', modelId: 'm' });

    // Clearing the pair removes the whole key (params included).
    const removed = mergeCompanySettings(stored, { conciergeModel: {} });
    assert.equal(removed.conciergeModel, undefined);
  });

  it('resolveConciergeModel passes params through and omits empty params', () => {
    assert.deepEqual(
      resolveConciergeModel({
        conciergeModel: { providerId: 'p', modelId: 'm', params: { maxContextTokens: 65_536 } },
      }),
      { providerId: 'p', modelId: 'm', params: { maxContextTokens: 65_536 } },
    );
    assert.deepEqual(resolveConciergeModel({ conciergeModel: { providerId: 'p', modelId: 'm' } }), {
      providerId: 'p',
      modelId: 'm',
    });
  });
});
