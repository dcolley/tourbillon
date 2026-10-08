/**
 * Env API keys are only attached when the request host matches the env (or built-in default)
 * base URL host for that provider. Matching host → key; mismatch / look-alike / userinfo → refuse.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  EnvCredentialHostError,
  envCredentialHostMatches,
  envCredentialHostRefusal,
  isEnvCredentialHostError,
} from './env-credential-host';
import {
  resolveModelProviderConfig,
  resolveModelProviderConfigFromEnv,
  resolveModelProviderConfigFromRecord,
  type LlmProviderRecord,
} from './model-provider';

const ENV_KEYS = [
  'LLM_PROVIDER',
  'LLM_BASE_URL',
  'OPENAI_BASE_URL',
  'LM_STUDIO_BASE_URL',
  'OLLAMA_BASE_URL',
  'LLM_API_KEY',
  'OPENAI_API_KEY',
  'LM_STUDIO_API_KEY',
  'OLLAMA_API_KEY',
  'LLM_API_MODE',
  'LLM_DEFAULT_MODEL',
] as const;

const saved: Record<string, string | undefined> = {};

function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

describe('envCredentialHostMatches', () => {
  it('matches the same host case-insensitively', () => {
    assert.equal(
      envCredentialHostMatches('https://api.openai.com/v1', 'https://API.OpenAI.com/v1/chat'),
      true,
    );
  });

  it('matches http → https upgrade on default ports', () => {
    assert.equal(
      envCredentialHostMatches('http://llm.example/v1', 'https://llm.example/v1'),
      true,
    );
  });

  it('refuses https → http downgrade', () => {
    assert.equal(
      envCredentialHostMatches('https://llm.example/v1', 'http://llm.example/v1'),
      false,
    );
  });

  it('refuses a different port', () => {
    assert.equal(
      envCredentialHostMatches('https://llm.example/v1', 'https://llm.example:8443/v1'),
      false,
    );
  });

  it('matches default https port written explicitly', () => {
    assert.equal(
      envCredentialHostMatches('https://llm.example/v1', 'https://llm.example:443/v1'),
      true,
    );
  });

  it('refuses a look-alike host that suffixes the real one', () => {
    assert.equal(
      envCredentialHostMatches('https://api.openai.com/v1', 'https://api.openai.com.evil.example/v1'),
      false,
    );
  });

  it('refuses a base URL with userinfo (user@host)', () => {
    assert.equal(
      envCredentialHostMatches('https://api.openai.com/v1', 'https://api.openai.com@other.example/v1'),
      false,
    );
  });

  it('refuses userinfo even on the right host (user:pass@api.openai.com)', () => {
    assert.equal(
      envCredentialHostMatches('https://api.openai.com/v1', 'https://user:pass@api.openai.com/v1'),
      false,
    );
  });

  it('compares IDN hosts via their ASCII (punycode) form', () => {
    // URL parser turns ü → xn--…; both sides must then match.
    assert.equal(
      envCredentialHostMatches('https://bücher.example/v1', 'https://xn--bcher-kva.example/v1'),
      true,
    );
  });

  it('refuses an unparseable configured URL', () => {
    assert.equal(envCredentialHostMatches('not a url', 'https://api.openai.com/v1'), false);
  });
});

describe('envCredentialHostRefusal', () => {
  it('returns null when hosts match', () => {
    assert.equal(
      envCredentialHostRefusal({
        providerLabel: 'OpenAI',
        keyEnvName: 'OPENAI_API_KEY',
        configuredBaseURL: 'https://api.openai.com/v1',
        requestBaseURL: 'https://api.openai.com/v1',
      }),
      null,
    );
  });

  it('names provider, expected host, actual host and env var; never the key', () => {
    const err = envCredentialHostRefusal({
      providerLabel: 'OpenAI',
      keyEnvName: 'OPENAI_API_KEY',
      configuredBaseURL: 'https://api.openai.com/v1',
      requestBaseURL: 'https://evil.example/v1',
    });
    assert.ok(err instanceof EnvCredentialHostError);
    assert.equal(err.code, 'llm_provider_base_url_host_mismatch');
    assert.equal(err.status, 409);
    assert.match(err.message, /OpenAI/);
    assert.match(err.message, /OPENAI_API_KEY/);
    assert.match(err.message, /api\.openai\.com/);
    assert.match(err.message, /evil\.example/);
    assert.doesNotMatch(err.message, /sk-/);
  });

  it('uses the credentials code when the request URL has userinfo', () => {
    const err = envCredentialHostRefusal({
      providerLabel: 'OpenAI',
      keyEnvName: 'OPENAI_API_KEY',
      configuredBaseURL: 'https://api.openai.com/v1',
      requestBaseURL: 'https://api.openai.com@other.example/v1',
    });
    assert.ok(err);
    assert.equal(err.code, 'llm_provider_base_url_credentials');
  });

  it('isEnvCredentialHostError recognises the error by shape', () => {
    const err = new EnvCredentialHostError('x', 'llm_provider_base_url_host_mismatch');
    assert.equal(isEnvCredentialHostError(err), true);
    assert.equal(isEnvCredentialHostError(new Error('nope')), false);
  });
});

describe('resolveModelProviderConfigFromEnv env key host check', () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    clearEnv();
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('matching host attaches the env key', () => {
    process.env.LLM_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'sk-env-match-test-key';
    process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1';
    const config = resolveModelProviderConfigFromEnv({
      provider: 'openai',
      baseURL: 'https://api.openai.com/v1',
    });
    assert.equal(config.apiKey, 'sk-env-match-test-key');
    assert.equal(config.baseURL, 'https://api.openai.com/v1');
  });

  it('mismatched baseURL refuses with no key attached', () => {
    process.env.LLM_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'sk-env-mismatch-test-key';
    process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1';
    assert.throws(
      () =>
        resolveModelProviderConfigFromEnv({
          provider: 'openai',
          baseURL: 'https://evil.example/v1',
        }),
      (err: unknown) => {
        assert.ok(isEnvCredentialHostError(err));
        assert.equal((err as EnvCredentialHostError).code, 'llm_provider_base_url_host_mismatch');
        assert.match((err as Error).message, /evil\.example/);
        assert.match((err as Error).message, /OPENAI_API_KEY|LLM_API_KEY/);
        assert.doesNotMatch((err as Error).message, /sk-env-mismatch/);
        return true;
      },
    );
  });

  it('look-alike host refuses (api.openai.com.evil.example)', () => {
    process.env.LLM_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'sk-env-lookalike-key';
    // No OPENAI_BASE_URL → built-in default https://api.openai.com/v1
    assert.throws(
      () =>
        resolveModelProviderConfigFromEnv({
          provider: 'openai',
          baseURL: 'https://api.openai.com.evil.example/v1',
        }),
      (err: unknown) => {
        assert.ok(isEnvCredentialHostError(err));
        assert.equal((err as EnvCredentialHostError).code, 'llm_provider_base_url_host_mismatch');
        return true;
      },
    );
  });

  it('userinfo trick (api.openai.com@other) refuses', () => {
    process.env.LLM_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'sk-env-userinfo-key';
    assert.throws(
      () =>
        resolveModelProviderConfigFromEnv({
          provider: 'openai',
          baseURL: 'https://api.openai.com@other.example/v1',
        }),
      (err: unknown) => {
        assert.ok(isEnvCredentialHostError(err));
        assert.equal((err as EnvCredentialHostError).code, 'llm_provider_base_url_credentials');
        return true;
      },
    );
  });

  it('no baseURL uses the default host and attaches the key', () => {
    process.env.LLM_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'sk-env-default-host-key';
    // No OPENAI_BASE_URL and no override → built-in default host.
    const config = resolveModelProviderConfigFromEnv({ provider: 'openai' });
    assert.equal(config.baseURL, 'https://api.openai.com/v1');
    assert.equal(config.apiKey, 'sk-env-default-host-key');
  });

  it('omit-key resolves without the key on mismatch (display path)', () => {
    process.env.LLM_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'sk-env-omit-key';
    const config = resolveModelProviderConfigFromEnv(
      { provider: 'openai', baseURL: 'https://evil.example/v1' },
      null,
      { onEnvCredentialHostMismatch: 'omit-key' },
    );
    assert.equal(config.apiKey, '');
    assert.equal(config.baseURL, 'https://evil.example/v1');
  });

  it('agent-supplied apiKey is kept even on a host mismatch (not an env key)', () => {
    process.env.LLM_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'sk-env-not-used';
    const config = resolveModelProviderConfigFromEnv({
      provider: 'openai',
      baseURL: 'https://evil.example/v1',
      apiKey: 'sk-agent-own-key',
    });
    assert.equal(config.apiKey, 'sk-agent-own-key');
  });

  it('provider-row path is unchanged (env key check does not apply)', () => {
    process.env.LLM_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'sk-env-ignored';
    const record: LlmProviderRecord = {
      id: 'prov-1',
      name: 'Gateway',
      type: 'openai-compatible',
      baseURL: 'https://gw.test/v1',
      apiKey: 'sk-provider-row-key',
      headers: { 'X-Team': 't1' },
      apiMode: 'chat',
      isDefault: true,
      defaultModelSettings: {},
      defaultModel: null,
      stickiness: 'off',
      stickinessHeaderName: 'x-litellm-session-id',
    };
    // Override base URL on another host with a provider row: today's behaviour is to merge
    // (the provider-row host check lives in #134). Env key is not involved.
    const config = resolveModelProviderConfig(
      { baseURL: 'https://evil.example/v1' },
      null,
      record,
    );
    assert.equal(config.apiKey, 'sk-provider-row-key');
    assert.equal(config.baseURL, 'https://evil.example/v1');
    assert.equal(config.headers['X-Team'], 't1');
    // From-record helper itself is untouched.
    const fromRecord = resolveModelProviderConfigFromRecord(record);
    assert.equal(fromRecord.apiKey, 'sk-provider-row-key');
    assert.equal(fromRecord.baseURL, 'https://gw.test/v1');
  });
});
