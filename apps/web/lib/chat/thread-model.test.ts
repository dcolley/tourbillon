/**
 * CHAT-5: what a chat run uses on a thread. No choice → the agent's model (no provider check). A
 * choice → controller options for its provider, model and effort, allowed only when the provider is
 * available to the agent's company (checked on every run).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveThreadRunModel, threadChoiceOverride, threadProviderRefusedBody } from './thread-model';

describe('CHAT-5 resolveThreadRunModel', () => {
  const checks: Array<[string, string]> = [];
  const deps = (on: boolean) => ({
    isProviderAvailable: async (companyId: string, providerId: string) => {
      checks.push([companyId, providerId]);
      return on;
    },
  });

  it('no choice → agent default, no provider check', async () => {
    checks.length = 0;
    assert.deepEqual(await resolveThreadRunModel('c1', null, deps(true)), { source: 'agent' });
    assert.equal(checks.length, 0);
  });

  it('choice with an available provider → allowed, with its options', async () => {
    checks.length = 0;
    const r = await resolveThreadRunModel('c1', { providerId: 'p2', modelId: 'm2', reasoningLevel: 'low' }, deps(true));
    assert.deepEqual(r, {
      source: 'thread',
      choice: { providerId: 'p2', modelId: 'm2', reasoningLevel: 'low' },
      opts: { modelIdOverride: 'm2', providerIdOverride: 'p2', reasoningLevelOverride: 'low' },
      allowed: true,
    });
    assert.deepEqual(checks, [['c1', 'p2']]);
  });

  it('choice with a disabled provider → refused', async () => {
    const r = await resolveThreadRunModel('c1', { providerId: 'p2', modelId: 'm2' }, deps(false));
    assert.equal(r.source, 'thread');
    assert.equal(r.source === 'thread' && r.allowed, false);
  });

  it('options leave effort unset when the choice has none; refusal body names no provider', () => {
    assert.deepEqual(threadChoiceOverride({ providerId: 'p', modelId: 'm' }), { modelIdOverride: 'm', providerIdOverride: 'p' });
    const body = threadProviderRefusedBody();
    assert.equal(body.code, 'provider_disabled_for_company');
    assert.equal(typeof body.error, 'string');
  });
});
