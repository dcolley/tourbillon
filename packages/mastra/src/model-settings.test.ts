/**
 * CONCIERGE-PARAMS: the chat context budget takes model params (concierge pair params) over
 * provider defaults and agent overrides; the same params are part of the controller cache key;
 * the tool-result capper stays active on the shared chat/heartbeat processor chain.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveAgentContextBudget, resolveAgentGenerationOptions } from './model-settings';
import { chatModelOverrideKey } from './chat-model-override';
import { buildHeartbeatInputProcessors } from './heartbeat-processors';

const agentRecord = (model: Record<string, unknown> = {}) =>
  ({
    id: 'a1',
    companyId: 'c1',
    modelId: 'qwen/qwen3.6-35b-a3b',
    providerId: 'prov-qwen',
    runtimeConfig: { model: { ...model } },
  }) as never;

const providerRecord = (maxContextTokens: number) =>
  ({ defaultModelSettings: { maxContextTokens } }) as never;

describe('CONCIERGE-PARAMS — resolveAgentContextBudget with paramsOverride', () => {
  it('uses the provider default when no params are set', () => {
    const budget = resolveAgentContextBudget(agentRecord(), providerRecord(132_000), 'chat');
    assert.equal(budget.contextTokens, 132_000);
  });

  it('params beat the provider default (65536 model window)', () => {
    const budget = resolveAgentContextBudget(
      agentRecord(),
      providerRecord(132_000),
      'chat',
      { maxContextTokens: 65_536, maxOutputTokens: 2_048 },
    );
    assert.equal(budget.contextTokens, 65_536);
    assert.equal(budget.outputReserve, 2_048);
    assert.equal(budget.limiterLimit, 55_488); // 65_536 − 2_048 − 8_000
  });

  it('params beat a per-agent maxContextTokens override too', () => {
    const budget = resolveAgentContextBudget(
      agentRecord({ maxContextTokens: 64_000 }),
      providerRecord(132_000),
      'chat',
      { maxContextTokens: 65_536 },
    );
    assert.equal(budget.contextTokens, 65_536);
  });

  it('generation options take params too (output reserve + temperature flow through)', () => {
    const options = resolveAgentGenerationOptions(
      agentRecord({ maxOutputTokens: 4_096 }),
      providerRecord(132_000),
      { maxContextTokens: 65_536, maxOutputTokens: 2_048, temperature: 0.7 },
    );
    assert.equal(options.modelSettings?.maxOutputTokens, 2_048);
    assert.equal(options.modelSettings?.temperature, 0.7);
    assert.equal((options.modelSettings as { maxContextTokens?: number }).maxContextTokens, undefined);
  });
});

describe('CONCIERGE-PARAMS — cache key + processor chain', () => {
  const base = { modelIdOverride: 'm', providerIdOverride: 'p1' };

  it('params make a distinct cache key; equal params keep the same key', () => {
    const withParams = { ...base, params: { maxContextTokens: 65_536 } };
    const otherParams = { ...base, params: { maxContextTokens: 132_000 } };
    assert.equal(new Set([chatModelOverrideKey(base), chatModelOverrideKey(withParams)]).size, 2);
    assert.equal(new Set([chatModelOverrideKey(withParams), chatModelOverrideKey(otherParams)]).size, 2);
    assert.equal(chatModelOverrideKey(withParams), chatModelOverrideKey({ ...withParams }));
  });

  it('chat and heartbeat keep one processor chain with the tool-result capper active', () => {
    const withParams = resolveAgentContextBudget(agentRecord(), providerRecord(132_000), 'chat', {
      maxContextTokens: 65_536,
    });
    const withoutParams = resolveAgentContextBudget(agentRecord(), providerRecord(132_000), 'chat');
    for (const budget of [withParams, withoutParams]) {
      const processors = buildHeartbeatInputProcessors({ limit: budget.limiterLimit }) as { id?: string }[];
      assert.ok(
        processors.some((p) => p.id === 'pin-plain-user-after-trim'),
        'tool-result cap (PinPlainUserAfterTrimProcessor) must stay in the chat chain',
      );
    }
  });
});
