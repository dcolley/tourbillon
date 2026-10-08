/**
 * #110 (PM decision): with no TOURBILLON_AGENT_TOKEN_SECRET, board chat routes (/api/chat/*) answer
 * 401 (not 500) and the server logs the config error, the same as agent API routes. The chat token
 * is minted by the real @/lib/auth/chat-token; only the chat registry/company modules are mocked.
 */
import { describe, it, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';

const env = process.env as Record<string, string | undefined>;
const SECRET = 'test-agent-token-secret-110-0123456789abcdef';

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

let failWith: 'mint' | 'other' = 'mint';
let mintedTokens: string[] = [];
const logged: unknown[][] = [];
const originalConsoleError = console.error;

describe('#110 /api/chat/* with no agent token secret', () => {
  const routes: Record<string, Handler> = {};

  before(async () => {
    const Module = require('module');
    const originalRequire = Module.prototype.require;
    class ChatAgentError extends Error {
      constructor(message: string, readonly status = 404) {
        super(message);
      }
    }
    class ActiveCompanyError extends Error {}
    const agent = { id: 'agent-a', urlKey: 'alice', name: 'Alice', companyId: 'company-a', modelId: 'm' };
    Module.prototype.require = function (id: string) {
      if (id === '@/lib/chat' || id.endsWith('/lib/chat') || id.endsWith('/lib/chat/index')) {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { buildChatScopedApiKey } = originalRequire.call(this, '@/lib/auth/chat-token');
        return {
          ChatAgentError,
          resolveChatAgent: async () => agent,
          chatResourceId: () => 'res-1',
          chatContextFromTags: () => ({}),
          getOrCreateChatController: async () => ({ id: 'ctrl-1' }),
          // Mirrors registry.getChatSession → createChatRequestContext → getOrCreateChatApiKey.
          getChatSession: async () => {
            if (failWith === 'other') throw new Error('boom');
            mintedTokens.push(buildChatScopedApiKey(`chat-${agent.id}`, agent.id, agent.companyId));
            throw new Error('unreachable in these tests');
          },
        };
      }
      if (id === '@/lib/company' || id.endsWith('/lib/company')) return { ActiveCompanyError };
      return originalRequire.apply(this, arguments as unknown as [string]);
    };
    routes['POST /api/chat/:agentId/sessions'] = (await import('./[agentId]/sessions/route')).POST as unknown as Handler;
    routes['GET .../threads/:threadId/messages'] = (await import('./[agentId]/sessions/[resourceId]/threads/[threadId]/messages/route')).GET as unknown as Handler;
    routes['GET .../stream'] = (await import('./[agentId]/sessions/[resourceId]/stream/route')).GET as unknown as Handler;
    routes['POST .../thread'] = (await import('./[agentId]/sessions/[resourceId]/thread/route')).POST as unknown as Handler;
    Module.prototype.require = originalRequire;
  });

  beforeEach(() => {
    delete env.TOURBILLON_AGENT_TOKEN_SECRET;
    failWith = 'mint';
    mintedTokens = [];
    logged.length = 0;
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
  });

  afterEach(() => {
    console.error = originalConsoleError;
  });

  const call = (name: string) => {
    const method = name.split(' ')[0];
    const req = new NextRequest('http://localhost/api/chat/alice/sessions/res-1/thread', {
      method,
      headers: { 'content-type': 'application/json', cookie: 'active_company_id=company-a' },
      ...(method === 'POST' ? { body: JSON.stringify({ threadId: 't-1' }) } : {}),
    });
    return routes[name](req, {
      params: Promise.resolve({ agentId: 'alice', resourceId: 'res-1', threadId: 't-1' }),
    });
  };

  for (const name of [
    'POST /api/chat/:agentId/sessions',
    'GET .../threads/:threadId/messages',
    'GET .../stream',
    'POST .../thread',
  ]) {
    it(`${name}: no secret → 401 and the config error is logged`, async () => {
      const res = await call(name);
      assert.equal(res.status, 401);
      const body = await res.text();
      assert.doesNotMatch(body, /pm_(run|chat)_/);
      const text = logged.map((args) => args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
      assert.ok(
        text.some((line) => line.includes('TOURBILLON_AGENT_TOKEN_SECRET is not set')),
        `config error logged (got: ${JSON.stringify(text)})`,
      );
      assert.ok(text.every((line) => !/pm_(run|chat)_/.test(line)), 'log never contains a token');
      assert.deepEqual(mintedTokens, [], 'no token minted without a secret');
    });
  }

  it('a short secret behaves the same (401 + log)', async () => {
    env.TOURBILLON_AGENT_TOKEN_SECRET = 'short';
    const res = await call('GET .../threads/:threadId/messages');
    assert.equal(res.status, 401);
    assert.ok(logged.some((args) => String(args[0]).includes('TOURBILLON_AGENT_TOKEN_SECRET')));
  });

  it('other chat errors still map to 500 (unchanged)', async () => {
    env.TOURBILLON_AGENT_TOKEN_SECRET = SECRET;
    failWith = 'other';
    const res = await call('GET .../threads/:threadId/messages');
    assert.equal(res.status, 500);
  });
});
