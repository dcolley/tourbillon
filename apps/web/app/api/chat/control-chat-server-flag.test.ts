/**
 * The legacy Control Pane chat session routes (/api/chat/[agentId]/sessions/**) are off on the
 * server unless CONTROL_CHAT_ENABLED and NEXT_PUBLIC_CONTROL_CHAT_ENABLED are both exactly 'true'
 * AND the assistant is off (ASSISTANT_ENABLED=false). While the assistant is available they stay off
 * whatever the legacy flags say. Off: every handler answers 404 before resolving the agent.
 * On: handlers run as before.
 *
 * '@/lib/chat' is mocked at the registry boundary; the session is a recording fake.
 */
import { describe, it, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';

const env = process.env as Record<string, string | undefined>;
type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

const RES = 'company-company-a:chat:free';
const agent = { id: 'agent-a', urlKey: 'alice', name: 'Alice', companyId: 'company-a', modelId: 'm' };

let resolved = 0;
let calls: string[] = [];

/** Records every session method called; thread lookups see a visible thread 't-1'. */
function fakeSession() {
  const thread = { id: 't-1', resourceId: RES, metadata: { agentId: agent.id } };
  const record = (name: string, result: unknown = undefined) => (..._args: unknown[]) => {
    calls.push(name);
    return result;
  };
  return {
    thread: {
      getId: () => 't-1',
      getById: async ({ threadId }: { threadId: string }) => ({ ...thread, id: threadId }),
      list: async () => [],
      listMessages: async () => [],
      create: record('thread.create', Promise.resolve({ ...thread, id: 't-3' })),
      clear: record('thread.clear'),
      switch: record('thread.switch', Promise.resolve()),
      rename: record('thread.rename', Promise.resolve()),
      delete: record('thread.delete', Promise.resolve()),
      setSetting: record('thread.setSetting', Promise.resolve()),
    },
    getResourceId: () => RES,
    model: { get: () => 'm' },
    mode: { get: () => undefined },
    displayState: { get: () => ({}) },
    subscribe: () => () => {},
    abort: record('abort'),
    sendMessage: record('sendMessage', Promise.resolve()),
    steer: record('steer', Promise.resolve()),
    followUp: record('followUp', Promise.resolve()),
    respondToToolApproval: record('respondToToolApproval'),
  };
}

type Route = { name: string; method: string; path: string; body?: unknown; effect?: string };
const ROUTES: Route[] = [
  { name: 'sessions', method: 'POST', path: '[agentId]/sessions/route', body: {} },
  { name: 'session', method: 'GET', path: '[agentId]/sessions/[resourceId]/route' },
  { name: 'stream', method: 'GET', path: '[agentId]/sessions/[resourceId]/stream/route' },
  { name: 'threads GET', method: 'GET', path: '[agentId]/sessions/[resourceId]/threads/route' },
  { name: 'threads POST', method: 'POST', path: '[agentId]/sessions/[resourceId]/threads/route', body: {} },
  { name: 'thread messages', method: 'GET', path: '[agentId]/sessions/[resourceId]/threads/[threadId]/messages/route' },
  { name: 'messages', method: 'POST', path: '[agentId]/sessions/[resourceId]/messages/route', body: { message: 'hi' }, effect: 'sendMessage' },
  { name: 'follow-up', method: 'POST', path: '[agentId]/sessions/[resourceId]/follow-up/route', body: { message: 'hi' }, effect: 'followUp' },
  { name: 'steer', method: 'POST', path: '[agentId]/sessions/[resourceId]/steer/route', body: { message: 'hi' }, effect: 'steer' },
  { name: 'abort', method: 'POST', path: '[agentId]/sessions/[resourceId]/abort/route', effect: 'abort' },
  { name: 'tool-approval', method: 'POST', path: '[agentId]/sessions/[resourceId]/tool-approval/route', body: { toolCallId: 'c1', approved: false }, effect: 'respondToToolApproval' },
  { name: 'thread switch', method: 'POST', path: '[agentId]/sessions/[resourceId]/thread/route', body: { threadId: 't-2' }, effect: 'thread.switch' },
  { name: 'thread rename', method: 'PATCH', path: '[agentId]/sessions/[resourceId]/threads/[threadId]/route', body: { title: 'New' }, effect: 'thread.rename' },
  { name: 'thread delete', method: 'DELETE', path: '[agentId]/sessions/[resourceId]/threads/[threadId]/route', effect: 'thread.delete' },
];

const handlers = new Map<string, Handler>();

async function call(route: Route): Promise<Response> {
  const req = new NextRequest(`http://localhost/api/chat/alice/sessions/${encodeURIComponent(RES)}/x`, {
    method: route.method,
    headers: { 'content-type': 'application/json', cookie: 'active_company_id=company-a' },
    ...(route.body !== undefined ? { body: JSON.stringify(route.body) } : {}),
  });
  const res = await handlers.get(route.name)!(req, {
    params: Promise.resolve({ agentId: 'alice', resourceId: RES, threadId: 't-2' }),
  });
  // Close an event stream right away so its heartbeat timer does not keep the test running.
  if (res.headers.get('content-type')?.startsWith('text/event-stream')) await res.body?.cancel();
  return res;
}

const enable = () => {
  env.CONTROL_CHAT_ENABLED = 'true';
  env.NEXT_PUBLIC_CONTROL_CHAT_ENABLED = 'true';
  env.ASSISTANT_ENABLED = 'false';
};

describe('legacy chat session routes: server-side flag, off while the assistant is available', () => {
  const KEYS = ['CONTROL_CHAT_ENABLED', 'NEXT_PUBLIC_CONTROL_CHAT_ENABLED', 'ASSISTANT_ENABLED'] as const;
  const saved = Object.fromEntries(KEYS.map((k) => [k, env[k]]));

  before(async () => {
    const Module = require('module');
    const originalRequire = Module.prototype.require;
    class ChatAgentError extends Error {
      constructor(message: string, readonly status = 404) {
        super(message);
      }
    }
    class ActiveCompanyError extends Error {}
    const chat: Record<string, unknown> = {
      ChatAgentError,
      resolveChatAgent: async () => {
        resolved += 1;
        return agent;
      },
      chatResourceId: () => RES,
      chatContextFromTags: () => ({}),
      getOrCreateChatController: async () => ({ id: 'ctrl-1', queryThreadById: async () => null }),
      getChatSession: async () => fakeSession(),
      createChatRequestContext: () => ({}),
      wrapMessageWithDashboardContext: (message: string) => message,
    };
    const chatModule = new Proxy(chat, {
      get: (target, key) => (key in target ? target[key as string] : (...args: unknown[]) => args[0]),
    });
    Module.prototype.require = function (this: unknown, id: string) {
      if (id === '@/lib/chat' || id.endsWith('/lib/chat') || id.endsWith('/lib/chat/index')) return chatModule;
      if (id === '@/lib/company' || id.endsWith('/lib/company')) return { ActiveCompanyError };
      return originalRequire.apply(this, arguments as unknown as [string]);
    };
    try {
      for (const route of ROUTES) {
        const mod = await import(`./${route.path}`);
        handlers.set(route.name, mod[route.method] as Handler);
      }
    } finally {
      Module.prototype.require = originalRequire;
    }
  });

  beforeEach(() => {
    resolved = 0;
    calls = [];
    for (const k of KEYS) delete env[k];
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete env[k];
      else env[k] = saved[k];
    }
  });

  const offCases: Array<[string, Record<string, string>]> = [
    ['both unset', {}],
    ['both legacy flags on, assistant available (ASSISTANT_ENABLED unset)', { CONTROL_CHAT_ENABLED: 'true', NEXT_PUBLIC_CONTROL_CHAT_ENABLED: 'true' }],
    ['both legacy flags on, ASSISTANT_ENABLED=true', { CONTROL_CHAT_ENABLED: 'true', NEXT_PUBLIC_CONTROL_CHAT_ENABLED: 'true', ASSISTANT_ENABLED: 'true' }],
    ['both legacy flags on, ASSISTANT_ENABLED not exactly "false"', { CONTROL_CHAT_ENABLED: 'true', NEXT_PUBLIC_CONTROL_CHAT_ENABLED: 'true', ASSISTANT_ENABLED: 'FALSE' }],
    ['assistant off, only the server flag', { CONTROL_CHAT_ENABLED: 'true', ASSISTANT_ENABLED: 'false' }],
    ['assistant off, only the build-time flag', { NEXT_PUBLIC_CONTROL_CHAT_ENABLED: 'true', ASSISTANT_ENABLED: 'false' }],
    ['assistant off, values other than "true"', { CONTROL_CHAT_ENABLED: '1', NEXT_PUBLIC_CONTROL_CHAT_ENABLED: 'TRUE', ASSISTANT_ENABLED: 'false' }],
  ];
  for (const [label, values] of offCases) {
    it(`off (${label}): every session route answers 404 without touching the agent or session`, async () => {
      Object.assign(env, values);
      for (const route of ROUTES) {
        const res = await call(route);
        assert.equal(res.status, 404, route.name);
        assert.deepEqual(await res.json(), { error: 'Not found' }, route.name);
      }
      assert.equal(resolved, 0, 'no agent resolved');
      assert.deepEqual(calls, [], 'no session method called');
    });
  }

  it('on (legacy flags on, assistant off): every session route runs (the agent is resolved, no flag 404)', async () => {
    enable();
    for (const route of ROUTES) {
      const before = resolved;
      const res = await call(route);
      assert.equal(resolved, before + 1, `${route.name} resolved the agent`);
      if (res.status >= 400) assert.fail(`${route.name}: ${res.status} ${await res.text()}`);
    }
  });

  it('on (legacy flags on, assistant off): changing routes reach the session', async () => {
    enable();
    for (const route of ROUTES.filter((r) => r.effect)) {
      calls = [];
      const res = await call(route);
      assert.equal(res.status, 200, route.name);
      assert.ok(calls.includes(route.effect!), `${route.name} called ${route.effect} (got ${calls.join(',')})`);
    }
  });
});
