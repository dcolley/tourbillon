import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  resolveModelProviderConfig,
  resolveModelProviderConfigFromRecord,
  type LlmProviderRecord,
} from './model-provider';

function makeRecord(overrides: Partial<LlmProviderRecord> = {}): LlmProviderRecord {
  return {
    id: 'prov-1',
    name: 'Test Provider',
    type: 'openai-compatible',
    baseURL: 'http://litellm.local:4000/v1',
    apiKey: 'sk-test',
    headers: {},
    apiMode: 'chat',
    isDefault: true,
    defaultModelSettings: {},
    defaultModel: null,
    stickiness: 'off',
    stickinessHeaderName: 'x-litellm-session-id',
    ...overrides,
  };
}

describe('resolveModelProviderConfigFromRecord', () => {
  const ENV_MODEL = 'env/fallback-model';
  let savedLlmDefault: string | undefined;
  let savedLmStudioDefault: string | undefined;

  beforeEach(() => {
    savedLlmDefault = process.env.LLM_DEFAULT_MODEL;
    savedLmStudioDefault = process.env.LM_STUDIO_DEFAULT_MODEL;
    process.env.LLM_DEFAULT_MODEL = ENV_MODEL;
    delete process.env.LM_STUDIO_DEFAULT_MODEL;
  });

  afterEach(() => {
    if (savedLlmDefault === undefined) delete process.env.LLM_DEFAULT_MODEL;
    else process.env.LLM_DEFAULT_MODEL = savedLlmDefault;
    if (savedLmStudioDefault === undefined) delete process.env.LM_STUDIO_DEFAULT_MODEL;
    else process.env.LM_STUDIO_DEFAULT_MODEL = savedLmStudioDefault;
  });

  it('explicit modelId wins over provider defaultModel', () => {
    const record = makeRecord({ defaultModel: 'provider/default-model' });
    const config = resolveModelProviderConfigFromRecord(record, 'agent/override-model');
    assert.equal(config.defaultModel, 'agent/override-model');
    assert.equal(config.providerId, 'prov-1');
    assert.equal(config.baseURL, 'http://litellm.local:4000/v1');
  });

  it('uses provider defaultModel when modelId is null and record.defaultModel is set', () => {
    const record = makeRecord({ defaultModel: 'provider/default-model' });
    const config = resolveModelProviderConfigFromRecord(record, null);
    assert.equal(config.defaultModel, 'provider/default-model');
  });

  it('falls back to env LLM_DEFAULT_MODEL when provider defaultModel is null or blank', () => {
    const nullRecord = makeRecord({ defaultModel: null });
    const blankRecord = makeRecord({ defaultModel: '   ' });
    assert.equal(resolveModelProviderConfigFromRecord(nullRecord, null).defaultModel, ENV_MODEL);
    assert.equal(resolveModelProviderConfigFromRecord(blankRecord, null).defaultModel, ENV_MODEL);
  });
});

describe('resolveModelProviderConfig', () => {
  const ENV_MODEL = 'env/fallback-model';
  let savedLlmDefault: string | undefined;

  beforeEach(() => {
    savedLlmDefault = process.env.LLM_DEFAULT_MODEL;
    process.env.LLM_DEFAULT_MODEL = ENV_MODEL;
  });

  afterEach(() => {
    if (savedLlmDefault === undefined) delete process.env.LLM_DEFAULT_MODEL;
    else process.env.LLM_DEFAULT_MODEL = savedLlmDefault;
  });

  it('with a provider record, explicit modelId still beats provider defaultModel', () => {
    const record = makeRecord({ defaultModel: 'provider/default-model' });
    const config = resolveModelProviderConfig(null, 'agent/override-model', record);
    assert.equal(config.defaultModel, 'agent/override-model');
  });

  it('with a provider record but no modelId, provider defaultModel wins over env', () => {
    const record = makeRecord({ defaultModel: 'provider/default-model' });
    const config = resolveModelProviderConfig(null, null, record);
    assert.equal(config.defaultModel, 'provider/default-model');
  });

  it('without a provider record, resolves model from env default', () => {
    const config = resolveModelProviderConfig(null, null, null);
    assert.equal(config.defaultModel, ENV_MODEL);
  });
});
