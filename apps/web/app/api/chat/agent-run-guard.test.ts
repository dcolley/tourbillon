/**
 * Chat turns for archived or pending-approval agents answer 409 before any controller is built.
 * Reading threads is unaffected; paused agents can still chat. The chat registry is mocked
 * (except the real guard and error type); no DB or model.
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

let status = 'active';
let controllersBuilt = 0;

describe('chat turns are refused for agents that cannot run', () => {
  const routes: Record<string, Handler> = {};
  let guard: typeof import('@/lib/chat/agent-run-guard');

  before(async () => {
    guard = await import('../../../lib/chat/agent-run-guard');
    const { ChatAgentError } = await import('../../../lib/chat/errors');
    const Module = require('module');
    const originalRequire = Module.prototype.require;
    Module.prototype.require = function (id: string) {
      if (id === '@/lib/chat' || id.endsWith('/lib/chat') || id.endsWith('/lib/chat/index')) {
        return {
          ChatAgentError,
          assertChatAgentCanRun: guard.assertChatAgentCanRun,
          resolveChatAgent: async () => ({ id: 'agent-a', urlKey: 'alice', companyId: 'company-a', status }),
          chatResourceId: () => 'res-1',
          chatContextFromTags: () => ({}),
          getOrCreateChatController: async () => {
            controllersBuilt += 1;
            throw new Error('controller should not be built in these tests');
          },
          getChatSession: async () => {
            throw new Error('session should not be created in these tests');
          },
        };
      }
      return originalRequire.apply(this, arguments as unknown as [string]);
    };
    const base = './[agentId]/sessions/[resourceId]';
    routes['GET stream'] = (await import(`${base}/stream/route`)).GET as unknown as Handler;
    routes['POST messages'] = (await import(`${base}/messages/route`)).POST as unknown as Handler;
    routes['POST follow-up'] = (await import(`${base}/follow-up/route`)).POST as unknown as Handler;
    routes['POST steer'] = (await import(`${base}/steer/route`)).POST as unknown as Handler;
    routes['POST tool-approval'] = (await import(`${base}/tool-approval/route`)).POST as unknown as Handler;
    Module.prototype.require = originalRequire;
  });

  beforeEach(() => {
    status = 'active';
    controllersBuilt = 0;
  });

  const call = (name: string) => {
    const method = name.split(' ')[0];
    const req = new NextRequest('http://localhost/api/chat/alice/sessions/res-1/x', {
      method,
      headers: { 'content-type': 'application/json', cookie: 'active_company_id=company-a' },
      ...(method === 'POST'
        ? { body: JSON.stringify({ content: 'hi', message: 'hi', toolCallId: 'tc-1', approved: true }) }
        : {}),
    });
    return routes[name](req, { params: Promise.resolve({ agentId: 'alice', resourceId: 'res-1' }) });
  };

  for (const name of ['GET stream', 'POST messages', 'POST follow-up', 'POST steer', 'POST tool-approval']) {
    for (const blocked of ['archived', 'pending_approval']) {
      it(`${name}: ${blocked} agent → 409, no controller built`, async () => {
        status = blocked;
        const res = await call(name);
        assert.equal(res.status, 409);
        const body = (await res.json()) as { error?: string };
        assert.match(String(body.error), /cannot chat/);
        assert.equal(controllersBuilt, 0);
      });
    }
  }

  it('active and paused agents pass the guard', () => {
    assert.doesNotThrow(() => guard.assertChatAgentCanRun({ status: 'active' }));
    assert.doesNotThrow(() => guard.assertChatAgentCanRun({ status: 'paused' }));
  });

  it('GET stream for an active agent goes on to build the controller', async () => {
    const res = await call('GET stream');
    assert.equal(controllersBuilt, 1);
    assert.equal(res.status, 500);
  });
});
