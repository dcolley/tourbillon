/**
 * Display path: agent list summary omits the env API key on a host mismatch and never throws.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { getAgentModelSummary } from './agent-model-summary';

const ENV_KEYS = [
  'LLM_PROVIDER', 'LLM_BASE_URL', 'OPENAI_BASE_URL', 'LM_STUDIO_BASE_URL', 'OLLAMA_BASE_URL',
  'LLM_API_KEY', 'OPENAI_API_KEY', 'LM_STUDIO_API_KEY', 'OLLAMA_API_KEY', 'LLM_API_MODE',
] as const;
const saved: Record<string, string | undefined> = {};

describe('getAgentModelSummary env credential host (display)', () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('mismatched agent: does not throw and never surfaces the env key', () => {
    process.env.LLM_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'sk-env-list-summary-key';
    process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1';
    // Empty providers → env fallback path (the omit-key display path).
    const summary = getAgentModelSummary(
      {
        modelId: 'gpt-test',
        providerId: null,
        adapterType: 'openai',
        adapterConfig: { baseURL: 'https://evil.example/v1' },
      },
      [],
    );
    assert.equal(summary.modelName, 'gpt-test');
    assert.equal(summary.providerName, 'openai');
    const blob = JSON.stringify(summary);
    assert.doesNotMatch(blob, /sk-env-list-summary/);
  });

  it('kind switch with no providers: does not throw and omits the env key', () => {
    process.env.LLM_PROVIDER = 'lmstudio';
    process.env.LLM_API_KEY = 'sk-env-list-kind-key';
    const summary = getAgentModelSummary(
      {
        modelId: null,
        providerId: null,
        adapterType: 'openai',
        adapterConfig: {},
      },
      [],
    );
    assert.ok(summary.providerName);
    assert.doesNotMatch(JSON.stringify(summary), /sk-env-list-kind/);
  });
});
