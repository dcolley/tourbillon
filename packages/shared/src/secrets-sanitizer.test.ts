import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  collectSecretValueEntries,
  redactAgentRuntimeSecrets,
  redactAgentSecretsDeep,
  scrubSecretValues,
  SECRET_VALUE_MIN_LENGTH,
} from './secrets-sanitizer';

const agent = {
  id: 'a1',
  runtimeConfig: {
    heartbeat: { enabled: true },
    secrets: { TEST_EMAIL: 'fixture@example.invalid', TEST_PASSWORD: 'Fixture-Passw0rd' },
    tavilyApiKey: 'tvly-fixture-key-000',
    mcpCredentials: { 'buffer-mcp': 'buffer-fixture-token' },
  },
};

describe('#100 secrets-sanitizer', () => {
  it('redactAgentRuntimeSecrets keeps key names only and does not mutate input', () => {
    const out = redactAgentRuntimeSecrets(agent);
    assert.deepEqual(out.runtimeConfig, {
      heartbeat: { enabled: true },
      secrets: { TEST_EMAIL: '[redacted]', TEST_PASSWORD: '[redacted]' },
      tavilyApiKey: '[redacted]',
      mcpCredentials: { 'buffer-mcp': '[redacted]' },
    });
    assert.equal(agent.runtimeConfig.secrets.TEST_PASSWORD, 'Fixture-Passw0rd');
  });

  it('redactAgentSecretsDeep finds runtimeConfig at any depth (lists, wrappers)', () => {
    const payload = { data: { agents: [agent] }, other: 'x' };
    const json = JSON.stringify(redactAgentSecretsDeep(payload));
    assert.ok(!json.includes('Fixture-Passw0rd'));
    assert.ok(!json.includes('fixture@example.invalid'));
    assert.ok(json.includes('TEST_PASSWORD'));
  });

  it('redactAgentSecretsDeep returns the same reference when nothing needs redaction', () => {
    const payload = { issues: [{ id: 'i1' }] };
    assert.equal(redactAgentSecretsDeep(payload), payload);
  });

  it('scrubSecretValues replaces known values with [REDACTED:<key>] and skips short values', () => {
    const entries = collectSecretValueEntries({ ...agent.runtimeConfig, secrets: { ...agent.runtimeConfig.secrets, PIN: '1234' } });
    assert.ok(entries.every(([, v]) => v.length >= SECRET_VALUE_MIN_LENGTH));
    const out = scrubSecretValues({ s: 'pw Fixture-Passw0rd pin 1234 key tvly-fixture-key-000' }, entries);
    assert.deepEqual(out, { s: 'pw [REDACTED:TEST_PASSWORD] pin 1234 key [REDACTED:tavilyApiKey]' });
  });
});
