/**
 * runs-follow-default: credential boundary for agent base URL overrides, and the provider row
 * order (agent → registry default → env) shared by the wake-runner and mastra chat.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ProviderConfigError,
  assertAgentOverrideWithinProviderBoundary,
  resolveAgentModelProviderConfig,
  resolveAgentProviderRow,
  resolveModelProviderConfig,
  sameCredentialBoundary,
  type LlmProviderRecord,
} from './model-provider';

const KEY = 'sk-provider-key-0123456789';
const HEADER = 'team-header-secret-42';

const record = (over: Partial<LlmProviderRecord> = {}): LlmProviderRecord => ({
  id: 'prov-1',
  name: 'Gateway',
  type: 'openai-compatible',
  baseURL: 'http://gw.test:8000/v1',
  apiKey: KEY,
  headers: { 'X-Team-Token': HEADER },
  apiMode: 'chat',
  isDefault: true,
  defaultModelSettings: {},
  defaultModel: null,
  stickiness: 'off',
  stickinessHeaderName: 'x-litellm-session-id',
  ...over,
});

const mismatch = (fn: () => unknown) =>
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof ProviderConfigError);
    assert.equal(err.code, 'llm_provider_base_url_host_mismatch');
    assert.equal(err.status, 409);
    assert.ok(!err.message.includes(KEY) && !err.message.includes(HEADER), err.message);
    return true;
  });

describe('sameCredentialBoundary', () => {
  it('same host+port (any path) is inside; another host, port or an https → http downgrade is not', () => {
    assert.equal(sameCredentialBoundary('http://gw.test:8000/v1', 'http://GW.test:8000/other'), true);
    assert.equal(sameCredentialBoundary('http://gw.test/v1', 'https://gw.test/v1'), true);
    assert.equal(sameCredentialBoundary('http://gw.test:8000/v1', 'http://evil.test:8000/v1'), false);
    assert.equal(sameCredentialBoundary('http://gw.test:8000/v1', 'http://gw.test:9000/v1'), false);
    assert.equal(sameCredentialBoundary('https://gw.test/v1', 'http://gw.test/v1'), false);
    assert.equal(sameCredentialBoundary('http://gw.test/v1', 'not a url'), false);
  });
});

describe('agent base URL override vs provider credentials (llm_provider_base_url_host_mismatch)', () => {
  it('override on another host + provider key/headers → 409 host mismatch, nothing resolved', () => {
    const overrides = { baseURL: 'http://evil.test:8000/v1' };
    mismatch(() => assertAgentOverrideWithinProviderBoundary(overrides, record()));
    mismatch(() => resolveAgentModelProviderConfig(overrides, 'm', record()));
  });

  it('error message names both origins only (no path, query or userinfo)', () => {
    try {
      assertAgentOverrideWithinProviderBoundary(
        { baseURL: 'http://u:p@evil.test/v1?token=abc' },
        record({ baseURL: 'http://gw.test:8000/secret-path?k=v' }),
      );
      assert.fail('expected a throw');
    } catch (err) {
      const msg = (err as Error).message;
      assert.match(msg, /http:\/\/evil\.test\)/);
      assert.match(msg, /"Gateway" \(http:\/\/gw\.test:8000\)/);
      assert.ok(!/u:p@|token=abc|secret-path|k=v/.test(msg), msg);
    }
  });

  it('key only, headers only: each alone is refused', () => {
    const overrides = { baseURL: 'http://evil.test/v1' };
    mismatch(() => resolveAgentModelProviderConfig(overrides, null, record({ headers: {} })));
    mismatch(() => resolveAgentModelProviderConfig(overrides, null, record({ apiKey: null })));
  });

  it('port change and unparseable override count as another host', () => {
    mismatch(() => resolveAgentModelProviderConfig({ baseURL: 'http://gw.test:9000/v1' }, null, record()));
    mismatch(() => resolveAgentModelProviderConfig({ baseURL: 'gw.test/v1' }, null, record()));
  });

  it('same-host override (other path, or http → https upgrade) still gets the key and headers', () => {
    const cfg = resolveAgentModelProviderConfig({ baseURL: 'http://gw.test:8000/v2' }, 'm', record());
    assert.equal(cfg.baseURL, 'http://gw.test:8000/v2');
    assert.equal(cfg.apiKey, KEY);
    assert.deepEqual(cfg.headers, { 'X-Team-Token': HEADER });
    const up = resolveAgentModelProviderConfig(
      { baseURL: 'https://gw.test/v1' },
      'm',
      record({ baseURL: 'http://gw.test/v1' }),
    );
    assert.equal(up.apiKey, KEY);
  });

  it('override that brings its own key and replaces every provider header is allowed (nothing of the provider is sent)', () => {
    const cfg = resolveAgentModelProviderConfig(
      { baseURL: 'http://own.test/v1', apiKey: 'agent-own-key', headers: { 'X-Team-Token': 'agent-own' } },
      'm',
      record(),
    );
    assert.equal(cfg.baseURL, 'http://own.test/v1');
    assert.equal(cfg.apiKey, 'agent-own-key');
    assert.ok(!Object.values(cfg.headers).includes(HEADER));
  });

  it('a different-case header name does not replace the provider header (both would be sent) → refused', () => {
    mismatch(() =>
      resolveAgentModelProviderConfig(
        { baseURL: 'http://own.test/v1', apiKey: 'agent-own-key', headers: { 'x-team-token': 'agent-own' } },
        'm',
        record(),
      ),
    );
  });

  it('own key but a provider header would still be sent → refused', () => {
    mismatch(() =>
      resolveAgentModelProviderConfig({ baseURL: 'http://own.test/v1', apiKey: 'agent-own-key' }, 'm', record()),
    );
  });

  it('keyless, headerless provider, no override, or env (no record) → no check', () => {
    const bare = record({ apiKey: null, headers: {} });
    assert.equal(resolveAgentModelProviderConfig({ baseURL: 'http://own.test/v1' }, null, bare).baseURL, 'http://own.test/v1');
    assert.equal(resolveAgentModelProviderConfig({ provider: 'vllm' }, null, record()).baseURL, 'http://gw.test:8000/v1');
    assert.equal(resolveAgentModelProviderConfig({ baseURL: 'http://own.test/v1' }, null, null).baseURL, 'http://own.test/v1');
  });

  it('display-only resolveModelProviderConfig is unchanged (does not throw)', () => {
    const cfg = resolveModelProviderConfig({ baseURL: 'http://evil.test/v1' }, null, record());
    assert.equal(cfg.baseURL, 'http://evil.test/v1');
  });
});

describe('resolveAgentProviderRow: agent → registry default → env', () => {
  const rows = { own: { id: 'own' }, def: { id: 'def' } } as const;
  const lookup = (opts: { own?: boolean; def?: boolean }, calls: string[] = []) => ({
    byId: async (id: string) => {
      calls.push(`byId:${id}`);
      return id === 'own' && opts.own ? rows.own : null;
    },
    registryDefault: async () => {
      calls.push('default');
      return opts.def ? rows.def : null;
    },
  });

  it("agent's own provider wins; the default is not even read", async () => {
    const calls: string[] = [];
    assert.deepEqual(await resolveAgentProviderRow('own', lookup({ own: true, def: true }, calls)), { row: rows.own, source: 'agent' });
    assert.deepEqual(calls, ['byId:own']);
  });

  it('no providerId → registry default', async () => {
    const calls: string[] = [];
    assert.deepEqual(await resolveAgentProviderRow(null, lookup({ def: true }, calls)), { row: rows.def, source: 'registry_default' });
    assert.deepEqual(calls, ['default']);
  });

  it('providerId whose row is gone → registry default', async () => {
    assert.deepEqual(await resolveAgentProviderRow('own', lookup({ def: true })), { row: rows.def, source: 'registry_default' });
  });

  it('no agent provider and no registry default → env (null)', async () => {
    assert.deepEqual(await resolveAgentProviderRow(undefined, lookup({})), { row: null, source: 'env' });
  });
});
