/**
 * CONCIERGE-OM S1 (gate #194): wiring pins for the memory-scope binding.
 *
 * Mutants that survived the first gates — getAgentMemory ignoring memoryScope, the
 * heartbeat default flipped to chat scope, the chat path sharing the heartbeat Memory —
 * all live in the scope→(cache key, OM resolver) pairing. These tests pin that pairing
 * directly (selectAgentMemoryResolution) and end-to-end (getAgentMemory returns distinct,
 * correctly-configured Memory instances per scope). No DB: DATABASE_URL is a fake, the
 * PostgresStore constructor never connects, and deps.omModelFor stubs the provider lookup.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

process.env.DATABASE_URL ??= 'postgres://user:***@127.0.0.1:5432/unused';

import {
  getAgentMemory,
  selectAgentMemoryResolution,
  type AgentMemoryResolvers,
} from './agent-factory';
import * as shared from '@tourbillon/shared/company-settings';
import type { AgentRuntimeConfig, CompanySettings } from '@tourbillon/shared';

const realResolvers: AgentMemoryResolvers = {
  memoryCacheKeyForAgent: shared.memoryCacheKeyForAgent,
  resolveAgentObservationalMemory: shared.resolveAgentObservationalMemory,
  memoryCacheKeyForChat: shared.memoryCacheKeyForChat,
  resolveChatObservationalMemory: shared.resolveChatObservationalMemory,
};

/** Company OM configured but DISABLED, agent explicitly off: heartbeat OM is off, chat OM is forced on. */
const companyOffWithModel: CompanySettings = {
  observationalMemory: { enabled: false, providerId: 'p-om', modelId: 'm-om' },
};
const agentOff = { observationalMemory: { mode: 'off' } } as unknown as AgentRuntimeConfig;

/** eslint-disable-next-line @typescript-eslint/no-explicit-any — threadConfig is a Mastra internal read for assertions. */
const threadConfig = (mem: object): any => (mem as { threadConfig?: Record<string, unknown> }).threadConfig ?? {};

describe('selectAgentMemoryResolution (CONCIERGE-OM S1)', () => {
  it("chat scope pairs memoryCacheKeyForChat WITH resolveChatObservationalMemory", () => {
    const { key, resolved } = selectAgentMemoryResolution(
      realResolvers,
      'chat',
      companyOffWithModel,
      agentOff,
    );
    assert.equal(key, 'chat-om:p-om:m-om:8192:30000:40000', 'chat uses the chat-om: key namespace');
    assert.ok(resolved, 'chat forces OM on even with company enabled:false + agent mode:off');
    assert.equal(resolved?.modelId, 'm-om');
  });

  it("heartbeat/default scope pairs memoryCacheKeyForAgent WITH resolveAgentObservationalMemory", () => {
    for (const scope of ['heartbeat', undefined] as const) {
      const { key, resolved } = selectAgentMemoryResolution(
        realResolvers,
        scope,
        companyOffWithModel,
        agentOff,
      );
      assert.equal(key, 'base', `heartbeat scope (${scope}) honours the off switches`);
      assert.equal(resolved, null, `heartbeat scope (${scope}) must NOT force OM on`);
    }
  });

  it('the two scopes can never collapse onto the same key when resolutions differ', () => {
    const chat = selectAgentMemoryResolution(realResolvers, 'chat', companyOffWithModel, agentOff);
    const heartbeat = selectAgentMemoryResolution(realResolvers, 'heartbeat', companyOffWithModel, agentOff);
    assert.notEqual(chat.key, heartbeat.key, 'a shared key would hand chat the heartbeat (OM-off) Memory');
  });

  it('a swapped resolver pair is detectable: chat keyed chat-om must resolve non-null', () => {
    // Simulates the swap mutant (chat key + heartbeat resolver, or vice versa) — the
    // invariant the call site must keep: key namespace and resolver come as a pair.
    const swapped: AgentMemoryResolvers = {
      ...realResolvers,
      resolveChatObservationalMemory: shared.resolveAgentObservationalMemory,
    };
    const { key, resolved } = selectAgentMemoryResolution(swapped, 'chat', companyOffWithModel, agentOff);
    assert.ok(key.startsWith('chat-om:'), 'key still chat-om (the mutant is the resolver half)');
    assert.equal(
      resolved === null,
      true,
      'swapping in the heartbeat resolver yields null for a forced-on chat case — the paired test below catches this in getAgentMemory',
    );
  });
});

describe('getAgentMemory scope wiring (CONCIERGE-OM S1)', () => {
  const omModelFor = async (providerId: string, modelId: string) =>
    ({ __omModel: `${providerId}/${modelId}` }) as never;

  it('chat and heartbeat resolutions are DISTINCT instances with the right OM config', async () => {
    const settings: CompanySettings = {
      observationalMemory: { enabled: false, providerId: `p-s1-${Date.now()}`, modelId: `m-s1-${Date.now()}` },
    };
    const chat = await getAgentMemory(settings, agentOff, 'chat', { omModelFor });
    const heartbeat = await getAgentMemory(settings, agentOff, 'heartbeat', { omModelFor });
    assert.notEqual(chat, heartbeat, 'chat must never reuse the heartbeat-keyed Memory instance');

    const chatOm = threadConfig(chat).observationalMemory;
    assert.ok(chatOm, 'chat Memory runs OM even when company is off and the agent is off');
    assert.equal(chatOm.observation.messageTokens, 30000, 'chat observation threshold from the chat resolver');
    assert.equal(chatOm.reflection.observationTokens, 40000, 'chat reflection threshold from the chat resolver');

    assert.equal(threadConfig(heartbeat).observationalMemory, undefined, 'heartbeat Memory honours the off switches');

    // Cache: same scope + same resolution → same instance (key lookup, not scope-ignored aliasing).
    const chatAgain = await getAgentMemory(settings, agentOff, 'chat', { omModelFor });
    assert.equal(chatAgain, chat, 'chat instances are cached by the chat-om key');
  });

  it('chat falls back to the concierge model for the OM observer', async () => {
    const stamp = Date.now();
    const settings: CompanySettings = {
      conciergeModel: { providerId: `p-c-${stamp}`, modelId: `m-c-${stamp}` },
    };
    const calls: Array<[string, string]> = [];
    const chat = await getAgentMemory(settings, null, 'chat', {
      omModelFor: async (p, m) => {
        calls.push([p, m]);
        return { __omModel: `${p}/${m}` } as never;
      },
    });
    assert.deepEqual(calls, [[`p-c-${stamp}`, `m-c-${stamp}`]], 'observer model resolved from the concierge pair');
    assert.ok(threadConfig(chat).observationalMemory, 'concierge-only companies still run OM in chat');
  });

  it('with no observer model anywhere both scopes share the plain base Memory (intended)', async () => {
    const stamp = `base-${Date.now()}`;
    const settings: CompanySettings = { conciergeModel: { modelId: `orphan-${stamp}` } };
    const chat = await getAgentMemory(settings, null, 'chat', { omModelFor });
    const heartbeat = await getAgentMemory(settings, null, undefined, { omModelFor });
    assert.equal(chat, heartbeat, "both key as 'base' and sharing a lastMessages-only Memory is intended");
    assert.equal(threadConfig(chat).observationalMemory, undefined);
  });
});
