/**
 * Agent model resolution with no LLM provider row: the env API key is sent only to the env (or
 * built-in default) base URL host. A different adapterConfig.baseURL host refuses before any
 * request, with no key sent.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { isEnvCredentialHostError } from '@tourbillon/shared';
import { getLanguageModelForAgent, getLanguageModelFromEnv } from './provider';

const ENV_KEYS = [
  'LLM_PROVIDER', 'LLM_BASE_URL', 'OPENAI_BASE_URL', 'LM_STUDIO_BASE_URL', 'OLLAMA_BASE_URL',
  'LLM_API_KEY', 'OPENAI_API_KEY', 'LM_STUDIO_API_KEY', 'OLLAMA_API_KEY', 'LLM_API_MODE',
] as const;
const saved: Record<string, string | undefined> = {};
const originalFetch = globalThis.fetch;
let requests: Array<{ url: string; authorization: string | null }> = [];

const completion = () =>
  Response.json({
    id: 'c1',
    object: 'chat.completion',
    created: 0,
    model: 'm1',
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });

const prompt = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }];

describe('agent model resolution: env key host check', () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    requests = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const headers = new Headers(init?.headers);
      requests.push({ url, authorization: headers.get('authorization') });
      return completion();
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('matching host: the env key is sent', async () => {
    process.env.LLM_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'sk-mastra-match-key';
    process.env.OPENAI_BASE_URL = 'https://llm-match.example/v1';
    const model = getLanguageModelForAgent(
      { adapterType: 'openai', adapterConfig: { baseURL: 'https://llm-match.example/v1' }, modelId: 'm1' },
      null,
    );
    await model.doGenerate({ prompt } as never);
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /^https:\/\/llm-match\.example\/v1\//);
    assert.equal(requests[0].authorization, 'Bearer sk-mastra-match-key');
  });

  it('mismatched adapterConfig.baseURL: refuses, nothing is sent', () => {
    process.env.LLM_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'sk-mastra-mismatch-key';
    assert.throws(
      () =>
        getLanguageModelForAgent(
          { adapterType: 'openai', adapterConfig: { baseURL: 'https://other-host.example/v1' }, modelId: 'm1' },
          null,
        ),
      (err: unknown) => {
        assert.ok(isEnvCredentialHostError(err));
        assert.doesNotMatch((err as Error).message, /sk-mastra/);
        return true;
      },
    );
    assert.equal(requests.length, 0);
  });

  it('look-alike host and userinfo trick refuse', () => {
    process.env.LLM_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'sk-mastra-lookalike-key';
    for (const baseURL of [
      'https://api.openai.com.evil.example/v1',
      'https://api.openai.com@other.example/v1',
      'http://api.openai.com/v1',
      'https://api.openai.com:8443/v1',
    ]) {
      assert.throws(
        () => getLanguageModelForAgent({ adapterType: 'openai', adapterConfig: { baseURL }, modelId: 'm1' }, null),
        (err: unknown) => isEnvCredentialHostError(err),
        baseURL,
      );
    }
    assert.equal(requests.length, 0);
  });

  it('provider-kind change with no baseURL: refuses, nothing is sent', () => {
    process.env.LLM_PROVIDER = 'lmstudio';
    process.env.LLM_API_KEY = 'sk-mastra-kind-switch-key';
    assert.throws(
      () => getLanguageModelForAgent({ adapterType: 'openai', adapterConfig: {}, modelId: 'm1' }, null),
      (err: unknown) => {
        assert.ok(isEnvCredentialHostError(err));
        assert.equal((err as { code?: string }).code, 'llm_provider_base_url_host_mismatch');
        assert.doesNotMatch((err as Error).message, /sk-mastra/);
        return true;
      },
    );
    assert.equal(requests.length, 0);
  });

  it('no baseURL: the built-in default host gets the key', async () => {
    process.env.LLM_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'sk-mastra-default-key';
    const model = getLanguageModelFromEnv(null, 'm1');
    await model.doGenerate({ prompt } as never);
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /^https:\/\/api\.openai\.com\/v1\//);
    assert.equal(requests[0].authorization, 'Bearer sk-mastra-default-key');
  });

  it('local placeholder key (no env key set) still works against any host', async () => {
    // lmstudio with no LM_STUDIO_API_KEY / LLM_API_KEY: placeholder, nothing secret to protect.
    const model = getLanguageModelForAgent(
      { adapterType: 'lmstudio', adapterConfig: { baseURL: 'http://lan-box.example:1234/v1' }, modelId: 'm1' },
      null,
    );
    await model.doGenerate({ prompt } as never);
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /^http:\/\/lan-box\.example:1234\/v1\//);
  });

  it('provider-row path is unchanged: the record key goes to its base URL', async () => {
    process.env.OPENAI_API_KEY = 'sk-mastra-env-unused';
    const model = getLanguageModelForAgent(
      { adapterType: 'openai', adapterConfig: {}, modelId: 'm1' },
      {
        id: 'prov-1', name: 'Gateway', type: 'openai-compatible', baseURL: 'https://gw-row.example/v1',
        apiKey: 'sk-mastra-row-key', headers: {}, apiMode: 'chat', isDefault: true,
        defaultModelSettings: {}, defaultModel: null, stickiness: 'off',
        stickinessHeaderName: 'x-litellm-session-id',
      },
    );
    await model.doGenerate({ prompt } as never);
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /^https:\/\/gw-row\.example\/v1\//);
    assert.equal(requests[0].authorization, 'Bearer sk-mastra-row-key');
  });
});
