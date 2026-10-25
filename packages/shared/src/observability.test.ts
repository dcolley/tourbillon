import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';
import { phoenixApiBaseUrl } from './observability';

const env = process.env as Record<string, string | undefined>;
const saved = { enabled: env.PHOENIX_COLLECTOR_ENABLED, endpoint: env.PHOENIX_COLLECTOR_ENDPOINT };

describe('OBS-2 phoenixApiBaseUrl', () => {
  afterEach(() => {
    env.PHOENIX_COLLECTOR_ENABLED = saved.enabled;
    env.PHOENIX_COLLECTOR_ENDPOINT = saved.endpoint;
    if (saved.enabled === undefined) delete env.PHOENIX_COLLECTOR_ENABLED;
    if (saved.endpoint === undefined) delete env.PHOENIX_COLLECTOR_ENDPOINT;
  });

  it('is undefined while the Phoenix collector is off', () => {
    delete env.PHOENIX_COLLECTOR_ENABLED;
    env.PHOENIX_COLLECTOR_ENDPOINT = 'http://phoenix.example:6006/v1/traces';
    assert.equal(phoenixApiBaseUrl(), undefined);
    env.PHOENIX_COLLECTOR_ENABLED = 'false';
    assert.equal(phoenixApiBaseUrl(), undefined);
  });

  it('strips /v1/traces from the collector endpoint (default and custom, with a path prefix)', () => {
    env.PHOENIX_COLLECTOR_ENABLED = 'true';
    delete env.PHOENIX_COLLECTOR_ENDPOINT;
    assert.equal(phoenixApiBaseUrl(), 'http://localhost:6006');
    env.PHOENIX_COLLECTOR_ENDPOINT = 'https://phoenix.example/v1/traces/';
    assert.equal(phoenixApiBaseUrl(), 'https://phoenix.example');
    env.PHOENIX_COLLECTOR_ENDPOINT = 'https://obs.example/phoenix/v1/traces?x=1';
    assert.equal(phoenixApiBaseUrl(), 'https://obs.example/phoenix');
  });

  it('refuses non-http(s), credentialed or malformed endpoints', () => {
    env.PHOENIX_COLLECTOR_ENABLED = 'true';
    for (const bad of ['grpc://phoenix.example:4317', 'http://user:pw@phoenix.example/v1/traces', 'not a url']) {
      env.PHOENIX_COLLECTOR_ENDPOINT = bad;
      assert.equal(phoenixApiBaseUrl(), undefined, bad);
    }
  });
});
