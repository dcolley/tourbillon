/**
 * WID-1: when a chat controller is dropped from the cache (agent model, model settings or
 * observational-memory change, company LLM provider toggle, cache clear), widgets parked on its
 * sessions are released: the parked owner run is aborted and the owner counts as gone, so the thread
 * is not left waiting on a session no request can reach. Real lib/chat/registry.ts, lib/agents.ts and
 * the provider PATCH route; the DB, auth and Mastra controller construction are stubbed.
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import {
  hasOtherSessionPendingWidget,
  recordWidgetOwner,
  resetWidgetOwnersForTests,
  widgetOwnership,
} from '../agui/widget-owners';

type Registry = typeof import('./registry');
type Cond = { col: string; val: unknown } | { and: Cond[] };

const AGENT_ROW = {
  id: 'agent-1',
  companyId: 'co-a',
  name: 'Writer',
  urlKey: 'writer',
  providerId: 'p-on',
  modelId: 'm-1',
  runtimeConfig: { heartbeat: { enabled: true, intervalSec: 300 } },
};

function parkedSession(toolCallId: string) {
  const state = { parked: true, aborts: 0 };
  return {
    state,
    suspensions: { has: (args: { toolCallId: string }) => state.parked && args.toolCallId === toolCallId },
    abort: () => {
      state.aborts += 1;
      state.parked = false;
    },
  };
}

const freshSession = () => ({ suspensions: { has: () => false } });
const tick = () => new Promise((r) => setImmediate(r));
const cache = () => {
  const g = globalThis as unknown as { tourbillonChatControllers?: Map<string, Promise<object>> };
  if (!g.tourbillonChatControllers) g.tourbillonChatControllers = new Map();
  return g.tourbillonChatControllers;
};

describe('WID-1 dropped chat controllers release their parked widgets', () => {
  let registry: Registry;
  let agentsLib: typeof import('../agents');
  let PATCH: (req: NextRequest, ctx: { params: Promise<{ companyId: string; id: string }> }) => Promise<Response>;

  before(async () => {
    const Module = require('module');
    const originalRequire = Module.prototype.require;
    const dbMock = {
      agents: { id: 'id', companyId: 'companyId', urlKey: 'urlKey' },
      companies: { id: 'id' },
      activityLog: {},
      assertLlmProviderEnabledForCompany: async () => {},
      db: {
        query: {
          agents: { findFirst: async () => ({ ...AGENT_ROW }) },
          companies: { findFirst: async () => ({ id: 'co-a', settings: {} }) },
        },
        select: () => ({ from: () => ({ where: async () => [{ id: AGENT_ROW.id }] }) }),
        update: () => ({
          set: (payload: Record<string, unknown>) => ({
            where: () => ({ returning: async () => [{ ...AGENT_ROW, ...payload }] }),
          }),
        }),
      },
    };
    let realRegistry: Registry | undefined;
    Module.prototype.require = function (this: { filename?: string }, id: string) {
      const from = this.filename ?? '';
      if (id === '@tourbillon/db') return dbMock;
      if (id === 'drizzle-orm') {
        return { eq: (col: string, val: unknown) => ({ col, val }), and: (...conds: Cond[]) => ({ and: conds }) };
      }
      if (id.endsWith('/packages/mastra/src/chat')) {
        return {
          buildChatControllerId: (agentId: string, modelId?: string) =>
            modelId ? `tourbillon-chat-${agentId}::${modelId}` : `tourbillon-chat-${agentId}`,
          buildChatResourceId: (companyId: string) => `company-${companyId}:chat:free`,
          createChatController: async () => ({ init: async () => {} }),
          createHeartbeatRuntimeContext: () => ({}),
        };
      }
      if (id === '@tourbillon/mastra') return { clearIdleThreadOnRuntimeSwitch: async () => {} };
      if (id === '@/lib/auth/chat-token' || id.endsWith('/lib/auth/chat-token')) {
        return { buildChatScopedApiKey: () => 'k', validateChatToken: () => null };
      }
      if (id === '@/lib/assistant/sidebar' || id.endsWith('/lib/assistant/sidebar')) {
        return { ASSISTANT_THREAD_METADATA_KEYS: [] };
      }
      if (id === './company' || id === '@/lib/company' || id.endsWith('/lib/company')) {
        return {
          getActiveCompany: async () => ({ id: 'co-a' }),
          getActiveCompanyOrNull: async () => ({ id: 'co-a', name: 'Alpha' }),
          hasBoardSession: async () => true,
        };
      }
      if (id === './mobile-auth' || id.endsWith('/lib/mobile-auth')) return { verifyMobileToken: async () => null };
      if (id === './llm-providers' && from.endsWith('/lib/agents.ts')) {
        return { getCompanyDefaultLlmProviderRecord: async () => null };
      }
      if (id === '@/lib/llm-providers' || id.endsWith('/lib/llm-providers')) {
        return {
          setLlmProviderEnabledForCompany: async (companyId: string, providerId: string, enabled: boolean) => ({
            providerId,
            companyId,
            enabledForCompany: enabled,
            changed: true,
          }),
        };
      }
      // lib/agents.ts and the provider route reach the real registry through lib/chat.
      if ((id === './chat' && from.endsWith('/lib/agents.ts')) || id === '@/lib/chat') {
        if (!realRegistry) throw new Error('registry not loaded yet');
        return realRegistry;
      }
      return originalRequire.apply(this, arguments as unknown as [string]);
    };
    try {
      registry = await import('./registry');
      realRegistry = registry;
      agentsLib = await import('../agents');
      ({ PATCH } = (await import('../../app/api/companies/[companyId]/llm-providers/[id]/route')) as unknown as {
        PATCH: typeof PATCH;
      });
    } finally {
      Module.prototype.require = originalRequire;
    }
  });

  beforeEach(() => {
    resetWidgetOwnersForTests();
    cache().clear();
  });

  /** Caches a controller for `key` with an owner session that has widget `w-1` parked on a thread. */
  function cachedControllerWithParkedWidget(key: string, threadId: string) {
    const controller = { id: key };
    cache().set(key, Promise.resolve(controller));
    const owner = parkedSession('w-1');
    recordWidgetOwner(owner, 'company-co-a:chat:free', threadId, 'w-1', controller);
    return { controller, owner };
  }

  const released = (threadId: string) => {
    const other = freshSession();
    return (
      !hasOtherSessionPendingWidget(other, 'company-co-a:chat:free', threadId) &&
      widgetOwnership(other, 'company-co-a:chat:free', threadId, 'w-1') === 'gone'
    );
  };

  it("invalidating an agent releases widgets on its controllers (incl. model overrides), not another agent's", async () => {
    const base = cachedControllerWithParkedWidget('tourbillon-chat-agent-1', 't1');
    const override = cachedControllerWithParkedWidget('tourbillon-chat-agent-1::m-x', 't2');
    const otherAgent = cachedControllerWithParkedWidget('tourbillon-chat-agent-2', 't3');
    assert.equal(hasOtherSessionPendingWidget(freshSession(), 'company-co-a:chat:free', 't1'), true);
    registry.invalidateChatControllerForAgent('agent-1');
    await tick();
    assert.equal(base.owner.state.aborts, 1);
    assert.equal(override.owner.state.aborts, 1);
    assert.ok(released('t1') && released('t2'));
    assert.equal(otherAgent.owner.state.aborts, 0);
    assert.equal(hasOtherSessionPendingWidget(freshSession(), 'company-co-a:chat:free', 't3'), true);
    assert.deepEqual([...cache().keys()], ['tourbillon-chat-agent-2']);
  });

  it('clearing the controller cache releases every parked widget', async () => {
    const a = cachedControllerWithParkedWidget('tourbillon-chat-agent-1', 't1');
    const b = cachedControllerWithParkedWidget('tourbillon-chat-agent-2', 't2');
    registry.clearChatControllerCache();
    await tick();
    assert.equal(a.owner.state.aborts + b.owner.state.aborts, 2);
    assert.ok(released('t1') && released('t2'));
  });

  it('a controller that failed to build is dropped without error', async () => {
    const failed = Promise.reject(new Error('build failed'));
    failed.catch(() => {});
    cache().set('tourbillon-chat-agent-1', failed);
    registry.invalidateChatControllerForAgent('agent-1');
    await tick();
    assert.equal(cache().size, 0);
  });

  const triggers: Array<[string, () => Promise<unknown>]> = [
    ['agent model change (updateAgentModel)', () => agentsLib.updateAgentModel('agent-1', { modelId: 'm-2', providerId: 'p-on' })],
    ['model settings change (updateAgentModelSettings)', () => agentsLib.updateAgentModelSettings('agent-1', { temperature: 0.5 } as never)],
    [
      'observational-memory change (updateAgentObservationalMemory)',
      () => agentsLib.updateAgentObservationalMemory('agent-1', { mode: 'off' }),
    ],
    [
      'company LLM provider toggle (PATCH llm-providers)',
      async () => {
        const res = await PATCH(
          new NextRequest('http://localhost/api/companies/co-a/llm-providers/p-on', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ enabled: false }),
          }),
          { params: Promise.resolve({ companyId: 'co-a', id: 'p-on' }) },
        );
        assert.equal(res.status, 200, await res.clone().text());
      },
    ],
  ];

  for (const [name, trigger] of triggers) {
    it(`${name} while a widget is pending releases the thread`, async () => {
      const { owner } = cachedControllerWithParkedWidget('tourbillon-chat-agent-1', 't1');
      await trigger();
      await tick();
      assert.equal(owner.state.aborts, 1, 'parked owner run aborted');
      assert.ok(released('t1'), 'other sessions are no longer refused');
      assert.equal(cache().has('tourbillon-chat-agent-1'), false);
    });
  }
});
