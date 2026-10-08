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
  resetBlankBaseUrlEnvWarningForTests,
  resolveModelProviderConfig,
  resolveModelProviderConfigFromEnv,
  resolveModelProviderConfigFromRecord,
  warnBlankBaseUrlEnvVars,
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

  it('refuses a look-alike host that prefixes the real one (evilapi.openai.com)', () => {
    // H2 mutant: endsWith(hostname) would wrongly allow evilapi.openai.com vs openai.com.
    assert.equal(
      envCredentialHostMatches('https://openai.com/v1', 'https://evilapi.openai.com/v1'),
      false,
    );
    assert.equal(
      envCredentialHostMatches('https://api.openai.com/v1', 'https://evilapi.openai.com/v1'),
      false,
    );
  });

  it('refuses http → https upgrade when either side uses a non-default port', () => {
    // H7 mutant: dropping the empty-port guard would allow this.
    assert.equal(
      envCredentialHostMatches('http://llm.example:8080/v1', 'https://llm.example:8443/v1'),
      false,
    );
    assert.equal(
      envCredentialHostMatches('http://llm.example:8080/v1', 'https://llm.example/v1'),
      false,
    );
    assert.equal(
      envCredentialHostMatches('http://llm.example/v1', 'https://llm.example:8443/v1'),
      false,
    );
  });

  it('refuses userinfo with username only (no password) on the right host', () => {
    // U2 mutant: password-only check would allow user@host.
    assert.equal(
      envCredentialHostMatches('https://api.openai.com/v1', 'https://user@api.openai.com/v1'),
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
    assert.match(err.message, /isn't sent/);
    assert.match(err.message, /Add an API key to the agent, or add an LLM provider/);
    assert.doesNotMatch(err.message, /sk-/);
  });

  it('refuses when the key has no configured base URL for this kind', () => {
    const err = envCredentialHostRefusal({
      providerLabel: 'OpenAI',
      keyEnvName: 'LLM_API_KEY',
      configuredBaseURL: null,
      requestBaseURL: 'https://api.openai.com/v1',
    });
    assert.ok(err);
    assert.equal(err.code, 'llm_provider_base_url_host_mismatch');
    assert.match(err.message, /not configured for any OpenAI host/);
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

  it('message never echoes the raw URL (path, query, fragment)', () => {
    // R2 mutant: returning raw from originForMessage would leak these.
    const err = envCredentialHostRefusal({
      providerLabel: 'OpenAI',
      keyEnvName: 'OPENAI_API_KEY',
      configuredBaseURL: 'https://api.openai.com/v1/secret-path?token=cfg-secret',
      requestBaseURL: 'https://evil.example/v1/leak?token=req-secret#frag',
    });
    assert.ok(err);
    assert.equal(err.code, 'llm_provider_base_url_host_mismatch');
    assert.match(err.message, /https:\/\/api\.openai\.com/);
    assert.match(err.message, /https:\/\/evil\.example/);
    assert.doesNotMatch(err.message, /secret-path|cfg-secret|req-secret|#frag|\/v1\/leak/);
  });

  it('credentials refusal message never echoes userinfo from the raw URL', () => {
    const err = envCredentialHostRefusal({
      providerLabel: 'OpenAI',
      keyEnvName: 'OPENAI_API_KEY',
      configuredBaseURL: 'https://api.openai.com/v1',
      requestBaseURL: 'https://alice:s3cret@api.openai.com/v1/leak?token=req-secret',
    });
    assert.ok(err);
    assert.equal(err.code, 'llm_provider_base_url_credentials');
    assert.doesNotMatch(err.message, /alice|s3cret|req-secret|\/v1\/leak/);
  });

  it('isEnvCredentialHostError requires the exact llm_provider_* code across bundles', () => {
    // Real class instance.
    const err = new EnvCredentialHostError('x', 'llm_provider_base_url_host_mismatch');
    assert.equal(isEnvCredentialHostError(err), true);
    assert.equal(isEnvCredentialHostError(new Error('nope')), false);

    // Cross-bundle structural path (R5 mutant drops this): plain Error with the right shape.
    const cross = Object.assign(new Error('cross-bundle host mismatch'), {
      name: 'ProviderConfigError',
      status: 409,
      code: 'llm_provider_base_url_host_mismatch',
    });
    assert.equal(isEnvCredentialHostError(cross), true);
    const crossCreds = Object.assign(new Error('cross-bundle credentials'), {
      name: 'ProviderConfigError',
      status: 409,
      code: 'llm_provider_base_url_credentials',
    });
    assert.equal(isEnvCredentialHostError(crossCreds), true);

    // Shape alone is not enough: wrong/missing code must not match.
    const wrongCode = Object.assign(new Error('other provider config'), {
      name: 'ProviderConfigError',
      status: 409,
      code: 'llm_provider_something_else',
    });
    assert.equal(isEnvCredentialHostError(wrongCode), false);
    const noCode = Object.assign(new Error('no code'), {
      name: 'ProviderConfigError',
      status: 409,
    });
    assert.equal(isEnvCredentialHostError(noCode), false);
    const wrongStatus = Object.assign(new Error('wrong status'), {
      name: 'ProviderConfigError',
      status: 400,
      code: 'llm_provider_base_url_host_mismatch',
    });
    assert.equal(isEnvCredentialHostError(wrongStatus), false);
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

  it('user@right-host with no password refuses (credentials code)', () => {
    process.env.LLM_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'sk-env-user-only-key';
    process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1';
    assert.throws(
      () =>
        resolveModelProviderConfigFromEnv({
          provider: 'openai',
          baseURL: 'https://alice@api.openai.com/v1',
        }),
      (err: unknown) => {
        assert.ok(isEnvCredentialHostError(err));
        assert.equal((err as EnvCredentialHostError).code, 'llm_provider_base_url_credentials');
        assert.doesNotMatch((err as Error).message, /alice|sk-env-user-only/);
        return true;
      },
    );
  });

  it('suffix lookalike evilapi.openai.com refuses at resolve time', () => {
    process.env.LLM_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'sk-env-suffix-key';
    process.env.OPENAI_BASE_URL = 'https://openai.com/v1';
    assert.throws(
      () =>
        resolveModelProviderConfigFromEnv({
          provider: 'openai',
          baseURL: 'https://evilapi.openai.com/v1',
        }),
      (err: unknown) => {
        assert.ok(isEnvCredentialHostError(err));
        assert.equal((err as EnvCredentialHostError).code, 'llm_provider_base_url_host_mismatch');
        assert.doesNotMatch((err as Error).message, /sk-env-suffix/);
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


describe('resolveModelProviderConfigFromEnv blank base URL env (S4)', () => {
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

  it('blank LLM_BASE_URL counts as unset and uses the built-in default host', () => {
    process.env.LLM_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'sk-env-blank-base-key';
    process.env.LLM_BASE_URL = '';
    const config = resolveModelProviderConfigFromEnv({ provider: 'openai' });
    // Not an empty baseURL that the SDK would reject — falls through to the openai default.
    assert.equal(config.baseURL, 'https://api.openai.com/v1');
    assert.equal(config.apiKey, 'sk-env-blank-base-key');
  });

  it('whitespace-only OPENAI_BASE_URL counts as unset', () => {
    process.env.LLM_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'sk-env-ws-base-key';
    process.env.OPENAI_BASE_URL = '   \t  ';
    const config = resolveModelProviderConfigFromEnv({ provider: 'openai' });
    assert.equal(config.baseURL, 'https://api.openai.com/v1');
    assert.equal(config.apiKey, 'sk-env-ws-base-key');
  });

  it('blank LLM_BASE_URL does not block a later real OPENAI_BASE_URL', () => {
    // openai-compatible prefers LLM_BASE_URL then OPENAI_BASE_URL.
    process.env.LLM_PROVIDER = 'openai-compatible';
    process.env.LLM_API_KEY = 'sk-env-blank-then-real-key';
    process.env.LLM_BASE_URL = '';
    process.env.OPENAI_BASE_URL = 'https://llm-real.example/v1';
    const config = resolveModelProviderConfigFromEnv({
      provider: 'openai-compatible',
      baseURL: 'https://llm-real.example/v1',
    });
    assert.equal(config.baseURL, 'https://llm-real.example/v1');
    assert.equal(config.apiKey, 'sk-env-blank-then-real-key');
  });

  it('blank base URL env still refuses a mismatched agent host with a clear 409', () => {
    process.env.LLM_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'sk-env-blank-mismatch-key';
    process.env.OPENAI_BASE_URL = ' ';
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
        assert.match((err as Error).message, /api\.openai\.com/);
        assert.doesNotMatch((err as Error).message, /sk-env-blank-mismatch|baseURL is not a valid URL|Failed to parse/i);
        return true;
      },
    );
  });
});

describe('warnBlankBaseUrlEnvVars (D1)', () => {
  const warns: string[] = [];
  let originalWarn: typeof console.warn;

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    clearEnv();
    resetBlankBaseUrlEnvWarningForTests();
    warns.length = 0;
    originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warns.push(args.map(String).join(' '));
    };
  });
  afterEach(() => {
    console.warn = originalWarn;
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetBlankBaseUrlEnvWarningForTests();
  });

  it('names blank and whitespace-only base URL vars once; never logs values', () => {
    process.env.OPENAI_BASE_URL = '';
    process.env.LLM_BASE_URL = '   \t  ';
    process.env.LM_STUDIO_BASE_URL = 'http://kept.example/v1';
    warnBlankBaseUrlEnvVars();
    warnBlankBaseUrlEnvVars(); // second call is a no-op
    assert.equal(warns.length, 2);
    assert.ok(warns.some((w) => w === 'OPENAI_BASE_URL is set but blank; treated as unset'));
    assert.ok(warns.some((w) => w === 'LLM_BASE_URL is set but blank; treated as unset'));
    assert.ok(!warns.some((w) => w.includes('LM_STUDIO_BASE_URL')));
    // Values must never appear in the warning text.
    for (const w of warns) {
      assert.doesNotMatch(w, /http:\/\/|sk-|kept\.example|\t/);
      assert.match(w, /^[A-Z0-9_]+ is set but blank; treated as unset$/);
    }
  });

  it('resolveModelProviderConfigFromEnv triggers the once-per-process warning', () => {
    process.env.OLLAMA_BASE_URL = ' ';
    resolveModelProviderConfigFromEnv({ provider: 'ollama' });
    resolveModelProviderConfigFromEnv({ provider: 'ollama' });
    assert.deepEqual(warns, ['OLLAMA_BASE_URL is set but blank; treated as unset']);
  });
});

describe('resolveModelProviderConfigFromEnv provider-kind change', () => {
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

  it('kind change with no baseURL refuses: the shared key is not sent to the other kind default host', () => {
    process.env.LLM_PROVIDER = 'lmstudio';
    process.env.LLM_API_KEY = 'sk-env-kind-switch-key';
    assert.throws(
      () => resolveModelProviderConfigFromEnv({ provider: 'openai' }),
      (err: unknown) => {
        assert.ok(isEnvCredentialHostError(err));
        assert.equal((err as EnvCredentialHostError).code, 'llm_provider_base_url_host_mismatch');
        const message = (err as Error).message;
        assert.match(message, /LLM_API_KEY/);
        assert.match(message, /isn't sent/);
        assert.match(message, /api\.openai\.com/);
        assert.match(message, /Add an API key to the agent, or add an LLM provider/);
        assert.doesNotMatch(message, /sk-env-kind-switch/);
        return true;
      },
    );
  });

  it('kind change refuses with the default env kind too (LLM_PROVIDER unset)', () => {
    process.env.OPENAI_API_KEY = 'sk-env-kind-default-key';
    assert.throws(
      () => resolveModelProviderConfigFromEnv({ provider: 'openai-compatible' }),
      (err: unknown) => isEnvCredentialHostError(err),
    );
    assert.throws(
      () => resolveModelProviderConfigFromEnv({ provider: 'openai' }),
      (err: unknown) => isEnvCredentialHostError(err),
    );
  });

  it('kind change to that kind default host given explicitly also refuses', () => {
    process.env.LLM_PROVIDER = 'lmstudio';
    process.env.LLM_API_KEY = 'sk-env-kind-explicit-key';
    assert.throws(
      () => resolveModelProviderConfigFromEnv({ provider: 'openai', baseURL: 'https://api.openai.com/v1' }),
      (err: unknown) => isEnvCredentialHostError(err),
    );
  });

  it('kind change keeps the key when that kind resolves to the env-configured base URL', () => {
    process.env.LLM_PROVIDER = 'lmstudio';
    process.env.LLM_BASE_URL = 'http://lan-llm.example:8000/v1';
    process.env.LLM_API_KEY = 'sk-env-kind-same-host-key';
    const config = resolveModelProviderConfigFromEnv({ provider: 'vllm' });
    assert.equal(config.baseURL, 'http://lan-llm.example:8000/v1');
    assert.equal(config.apiKey, 'sk-env-kind-same-host-key');
  });

  it('same kind as the env kind keeps the default host', () => {
    process.env.LLM_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'sk-env-kind-match-key';
    const config = resolveModelProviderConfigFromEnv({ provider: 'openai' });
    assert.equal(config.baseURL, 'https://api.openai.com/v1');
    assert.equal(config.apiKey, 'sk-env-kind-match-key');
    const noOverride = resolveModelProviderConfig();
    assert.equal(noOverride.apiKey, 'sk-env-kind-match-key');
  });

  it('kind change with omit-key resolves without the key (display path)', () => {
    process.env.LLM_PROVIDER = 'lmstudio';
    process.env.LLM_API_KEY = 'sk-env-kind-omit-key';
    const config = resolveModelProviderConfigFromEnv({ provider: 'openai' }, null, {
      onEnvCredentialHostMismatch: 'omit-key',
    });
    assert.equal(config.apiKey, '');
    assert.equal(config.baseURL, 'https://api.openai.com/v1');
  });

  it('kind change with no env key set is unaffected (placeholder / empty key)', () => {
    process.env.LLM_PROVIDER = 'openai';
    const config = resolveModelProviderConfigFromEnv({ provider: 'lmstudio' });
    assert.equal(config.apiKey, 'lm-studio');
    assert.equal(config.baseURL, 'http://localhost:1234/v1');
  });
});
