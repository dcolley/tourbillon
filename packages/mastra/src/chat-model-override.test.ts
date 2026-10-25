/**
 * CHAT-5: per-thread model choice helpers (controller key, effective record, model source) and the
 * tracing attributes a thread choice adds.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chatEffectiveRecord, chatModelOverrideKey, chatModelSource } from './chat-model-override';
import { buildAssistantTracingOptions } from './observability/assistant-tracing';
import { modelProviderOverridesFromAgent } from '@tourbillon/shared';

const agent = {
  id: 'agent-1',
  modelId: 'agent/model',
  providerId: 'provider-agent',
  adapterType: 'lmstudio' as const,
  adapterConfig: { baseURL: 'http://agent-host.example:1234/v1', headers: { 'x-agent': 'value' } },
};

describe('CHAT-5 chatModelOverrideKey', () => {
  it('no override → no key; model only → the legacy model-id key', () => {
    assert.equal(chatModelOverrideKey(undefined), undefined);
    assert.equal(chatModelOverrideKey({}), undefined);
    assert.equal(chatModelOverrideKey({ modelIdOverride: '  m-1 ' }), 'm-1');
  });

  it('provider and effort make distinct keys', () => {
    const a = chatModelOverrideKey({ modelIdOverride: 'm', providerIdOverride: 'p1' });
    const b = chatModelOverrideKey({ modelIdOverride: 'm', providerIdOverride: 'p2' });
    const c = chatModelOverrideKey({ modelIdOverride: 'm', providerIdOverride: 'p1', reasoningLevelOverride: 'high' });
    assert.equal(a, 'm::provider=p1::effort=');
    assert.equal(c, 'm::provider=p1::effort=high');
    assert.equal(new Set([a, b, c, 'm']).size, 4);
  });
});

describe('CHAT-5 chatEffectiveRecord', () => {
  it('returns the agent record unchanged without an override', () => {
    assert.equal(chatEffectiveRecord(agent, undefined), agent);
    assert.equal(chatEffectiveRecord(agent, { modelIdOverride: agent.modelId }), agent);
  });

  it('applies model and provider without touching the original record', () => {
    const next = chatEffectiveRecord(agent, { modelIdOverride: 'other/model', providerIdOverride: 'provider-b' });
    assert.equal(next.modelId, 'other/model');
    assert.equal(next.providerId, 'provider-b');
    assert.equal(next.id, 'agent-1');
    assert.equal(agent.modelId, 'agent/model');
    assert.equal(agent.providerId, 'provider-agent');
  });
});

describe('CHAT-5 chatModelSource', () => {
  it("keeps the agent's adapter settings for its own provider", () => {
    assert.equal(chatModelSource(agent, { modelIdOverride: 'x' }), agent);
  });

  it("drops the agent's adapter connection settings when the thread picked another provider", () => {
    const source = chatModelSource({ ...agent, modelId: 'other/model' }, { providerIdOverride: 'provider-b' });
    assert.equal(source.modelId, 'other/model');
    assert.deepEqual(modelProviderOverridesFromAgent(source.adapterType, source.adapterConfig), {});
  });
});

describe('CHAT-5 tracing attributes', () => {
  it('adds modelSource and reasoningLevel only when set', () => {
    const base = { companyId: 'c', agentId: 'a', threadId: 't', provider: 'p', model: 'm' };
    const plain = buildAssistantTracingOptions(base, { enabled: true })!;
    assert.equal(plain.metadata.modelSource, undefined);
    assert.equal(plain.metadata.reasoningLevel, undefined);
    const thread = buildAssistantTracingOptions(
      { ...base, modelSource: 'thread', reasoningLevel: 'high' },
      { enabled: true },
    )!;
    assert.equal(thread.metadata.modelSource, 'thread');
    assert.equal(thread.metadata.reasoningLevel, 'high');
    assert.equal(thread.metadata.model, 'm');
    assert.equal(thread.metadata.provider, 'p');
  });
});
