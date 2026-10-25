/**
 * OBS-2: reactions API — /api/assistant/agents/[agentId]/threads/[threadId]/feedback (GET, PUT).
 * Auth/company scope, validation, message checks, idempotency per user per message, persistence,
 * and the Phoenix annotation (client mocked; skipped when Phoenix is unset or the message has no trace).
 *
 * Same harness as assistant-routes.test.ts: '@/lib/chat' is mocked at the registry boundary and
 * sessions come from a real Mastra AgentController on in-memory storage, so threads and messages are
 * real Mastra memory. The metadata write (feedback-store.ts, SQL covered in feedback-store.test.ts)
 * is replaced by an in-memory equivalent.
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { NextRequest } from 'next/server';

const mastraRequire = createRequire(join(__dirname, '../../../../../packages/mastra/package.json'));

type Json = Record<string, any>;
type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

const AGENTS = [
  { id: 'agent-a', urlKey: 'alice', name: 'Alice', companyId: 'company-a', status: 'active' },
  { id: 'agent-b', urlKey: 'bob', name: 'Bob', companyId: 'company-a', status: 'active' },
  { id: 'agent-x', urlKey: 'xavier', name: 'Xavier', companyId: 'company-x', status: 'active' },
];
const RESOURCE_A = 'company-company-a:chat:free';
const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';

let activeCompany: { id: string } | null = { id: 'company-a' };
let controller: any;
let viewer = 'user-1';
/** Phoenix configured? (stands in for phoenixApiBaseUrl()). */
let phoenixConfigured = true;
let phoenixOutcome: 'sent' | 'failed' = 'sent';
const annotations: Json[] = [];
const storeWrites: Json[] = [];

class ChatAgentError extends Error {
  constructor(message: string, readonly status = 404) {
    super(message);
  }
}
class ActiveCompanyError extends Error {
  constructor() {
    super('No active company selected');
  }
}

async function createMemoryController() {
  const { AgentController } = mastraRequire('@mastra/core/agent-controller');
  const { Agent } = mastraRequire('@mastra/core/agent');
  const { MastraLanguageModelV2Mock } = mastraRequire('@mastra/core/test-utils/llm-mock');
  const { InMemoryStore } = mastraRequire('@mastra/core/storage');
  const { Memory } = mastraRequire('@mastra/memory');
  const storage = new InMemoryStore();
  const c = new AgentController({
    id: 'feedback-test-controller',
    storage,
    memory: new Memory({ storage, options: { lastMessages: 20, semanticRecall: false } }),
    agent: new Agent({ id: 'stub-agent', name: 'Stub', instructions: 'Test agent.', model: new MastraLanguageModelV2Mock({}) }),
    modes: [{ id: 'default', name: 'Default', default: true, defaultModelId: 'stub/stub' }],
    initialState: { yolo: true },
  });
  await c.init();
  return c;
}

async function memory() {
  return controller.getMemoryStorage();
}

/** A thread tagged to the agent with a user message and an assistant reply (traced or not). */
async function seedThread(opts: { id: string; agentId?: string; resourceId?: string; traced?: boolean }) {
  const mem = await memory();
  const resourceId = opts.resourceId ?? RESOURCE_A;
  const now = Date.now();
  await mem.saveThread({
    thread: {
      id: opts.id,
      resourceId,
      title: opts.id,
      metadata: opts.agentId ? { agentId: opts.agentId, kind: 'chat', contextType: 'free' } : {},
      createdAt: new Date(now),
      updatedAt: new Date(now),
    },
  });
  await mem.saveMessages({
    messages: [
      {
        id: `${opts.id}-u`,
        threadId: opts.id,
        resourceId,
        role: 'user',
        createdAt: new Date(now),
        content: { format: 2, parts: [{ type: 'text', text: 'question' }] },
      },
      {
        id: `${opts.id}-a`,
        threadId: opts.id,
        resourceId,
        role: 'assistant',
        createdAt: new Date(now + 1),
        content: {
          format: 2,
          parts: [{ type: 'text', text: 'answer' }],
          ...(opts.traced === false ? {} : { metadata: { traceId: TRACE_ID } }),
        },
      },
    ],
  });
}

/** In-memory stand-in for lib/assistant/feedback-store (same scope check, same merge). */
const memoryFeedbackStore = {
  async saveAssistantMessageFeedbackRow(
    scope: { threadId: string; resourceId: string; agentId: string },
    messageId: string,
    userKey: string,
    entry: Json,
  ) {
    storeWrites.push({ ...scope, messageId, userKey, entry });
    const mem = await memory();
    const t = await mem.getThreadById({ threadId: scope.threadId });
    if (!t || t.resourceId !== scope.resourceId || t.metadata?.agentId !== scope.agentId) return false;
    const all = { ...(t.metadata?.assistantFeedback ?? {}) };
    all[messageId] = { ...(all[messageId] ?? {}), [userKey]: entry };
    await mem.updateThread({ id: t.id, title: t.title, metadata: { assistantFeedback: all } });
    return true;
  },
};

let feedbackGET: Handler;
let feedbackPUT: Handler;

const req = (url: string, init: { method?: string; body?: unknown } = {}) =>
  new NextRequest(`http://localhost${url}`, {
    method: init.method ?? 'GET',
    headers: { 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : typeof init.body === 'string' ? init.body : JSON.stringify(init.body),
  });
const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) });
const url = (agentId: string, threadId: string) => `/api/assistant/agents/${agentId}/threads/${threadId}/feedback`;

async function get(agentId: string, threadId: string): Promise<{ status: number; body: Json }> {
  const res = await feedbackGET(req(url(agentId, threadId)), ctx({ agentId, threadId }));
  return { status: res.status, body: (await res.json()) as Json };
}
async function put(agentId: string, threadId: string, body: unknown): Promise<{ status: number; body: Json }> {
  const res = await feedbackPUT(req(url(agentId, threadId), { method: 'PUT', body }), ctx({ agentId, threadId }));
  return { status: res.status, body: (await res.json()) as Json };
}

describe('OBS-2 assistant feedback API', () => {
  before(async () => {
    const Module = require('module');
    const originalRequire = Module.prototype.require;
    Module.prototype.require = function (this: { filename?: string }, id: string) {
      if (id === '@/lib/company') {
        return {
          ActiveCompanyError,
          getActiveCompanyOrNull: async () => activeCompany,
          getActiveCompany: async () => {
            if (!activeCompany) throw new ActiveCompanyError();
            return activeCompany;
          },
        };
      }
      if (id === '@/lib/mobile-auth') return { verifyMobileToken: async () => null };
      if (id === '@/lib/assistant/viewer') return { assistantViewerKey: async () => viewer };
      if (id === '@/lib/assistant/feedback-store') return memoryFeedbackStore;
      if (id === '@/lib/assistant/phoenix-annotations') {
        return {
          postTraceAnnotation: async (annotation: Json) => {
            if (!phoenixConfigured) return 'skipped';
            annotations.push(annotation);
            return phoenixOutcome;
          },
        };
      }
      if (id === '@/lib/chat') {
        return {
          ChatAgentError,
          chatResourceId: (companyId: string) => `company-${companyId}:chat:free`,
          resolveChatAgent: async (key: string) => {
            if (!activeCompany) throw new ActiveCompanyError();
            const agent = AGENTS.find((a) => (a.id === key || a.urlKey === key) && a.companyId === activeCompany!.id);
            if (!agent) throw new ChatAgentError('Agent not found', 404);
            return agent;
          },
          getOrCreateChatController: async () => controller,
          getChatSession: async (_c: unknown, _agent: unknown, opts: { resourceId: string; scope: string }) =>
            controller.createSession({
              resourceId: opts.resourceId,
              id: `${opts.resourceId}::${opts.scope}`,
              ownerId: controller.id,
              scope: opts.scope,
              createInitialThread: false,
            }),
        };
      }
      return originalRequire.apply(this, arguments as unknown as [string]);
    };
    ({ GET: feedbackGET, PUT: feedbackPUT } = (await import(
      './agents/[agentId]/threads/[threadId]/feedback/route'
    )) as any);
  });

  beforeEach(async () => {
    activeCompany = { id: 'company-a' };
    controller = await createMemoryController();
    viewer = 'user-1';
    phoenixConfigured = true;
    phoenixOutcome = 'sent';
    annotations.length = 0;
    storeWrites.length = 0;
    await seedThread({ id: 'own', agentId: 'agent-a' });
    await seedThread({ id: 'untraced', agentId: 'agent-a', traced: false });
    await seedThread({ id: 'bobs', agentId: 'agent-b' });
    await seedThread({ id: 'untagged' });
    await seedThread({ id: 'other-co', agentId: 'agent-a', resourceId: 'company-company-x:chat:free' });
  });

  describe('auth and scope', () => {
    it('no active company → 400; another company’s agent → 404; nothing written or annotated', async () => {
      activeCompany = null;
      assert.equal((await get('alice', 'own')).status, 400);
      assert.equal((await put('alice', 'own', { messageId: 'own-a', rating: 'up' })).status, 400);
      activeCompany = { id: 'company-a' };
      assert.equal((await get('xavier', 'own')).status, 404);
      assert.equal((await put('agent-x', 'own', { messageId: 'own-a', rating: 'up' })).status, 404);
      assert.deepEqual(storeWrites, []);
      assert.deepEqual(annotations, []);
    });

    it('threads not tagged to the agent, or outside the company resource, are 404', async () => {
      for (const threadId of ['bobs', 'untagged', 'other-co', 'missing']) {
        assert.equal((await get('alice', threadId)).status, 404, threadId);
        assert.equal((await put('alice', threadId, { messageId: `${threadId}-a`, rating: 'up' })).status, 404, threadId);
      }
      assert.deepEqual(storeWrites, []);
    });

    it('only assistant messages of this thread: user message, unknown id or another thread’s message → 404', async () => {
      assert.equal((await put('alice', 'own', { messageId: 'own-u', rating: 'up' })).status, 404);
      assert.equal((await put('alice', 'own', { messageId: 'nope', rating: 'up' })).status, 404);
      assert.equal((await put('alice', 'own', { messageId: 'bobs-a', rating: 'up' })).status, 404);
      assert.deepEqual(storeWrites, []);
    });

    it('invalid bodies → 400 (rating, tags, reason length, extra keys such as a client trace id)', async () => {
      for (const body of [
        'not json',
        {},
        { messageId: 'own-a', rating: 'maybe' },
        { messageId: 'own-a', rating: 'down', tags: ['x'] },
        { messageId: 'own-a', rating: 'down', reason: 'x'.repeat(501) },
        { messageId: 'own-a', rating: 'up', traceId: TRACE_ID },
      ]) {
        assert.equal((await put('alice', 'own', body)).status, 400, JSON.stringify(body).slice(0, 60));
      }
      assert.deepEqual(storeWrites, []);
    });
  });

  describe('reactions', () => {
    it('thumbs down with reason persists (GET after a fresh controller read) and annotates the stored trace', async () => {
      const r = await put('alice', 'own', { messageId: 'own-a', rating: 'down', reason: ' Wrong date ', tags: ['incorrect'] });
      assert.equal(r.status, 200);
      assert.equal(r.body.messageId, 'own-a');
      assert.equal(r.body.annotation, 'sent');
      assert.deepEqual(
        { rating: r.body.feedback.rating, reason: r.body.feedback.reason, tags: r.body.feedback.tags },
        { rating: 'down', reason: 'Wrong date', tags: ['incorrect'] },
      );

      const g = await get('alice', 'own');
      assert.equal(g.status, 200);
      assert.deepEqual(g.body.feedback, { 'own-a': r.body.feedback });

      assert.equal(annotations.length, 1);
      assert.deepEqual(annotations[0], {
        trace_id: TRACE_ID,
        name: 'user_feedback',
        annotator_kind: 'HUMAN',
        identifier: 'user:user-1:message:own-a',
        result: { label: 'thumbs_down', score: 0, explanation: 'Wrong date' },
        metadata: { userId: 'user-1', messageId: 'own-a', threadId: 'own', agentId: 'agent-a', companyId: 'company-a', tags: ['incorrect'] },
      });
    });

    it('idempotent per user per message: repeats and changes replace the one entry and reuse the annotation identifier', async () => {
      await put('alice', 'own', { messageId: 'own-a', rating: 'up' });
      await put('alice', 'own', { messageId: 'own-a', rating: 'up' });
      const changed = await put('alice', 'own', { messageId: 'own-a', rating: 'down', tags: ['unhelpful'] });
      assert.equal(changed.status, 200);

      const g = await get('alice', 'own');
      assert.deepEqual(Object.keys(g.body.feedback), ['own-a']);
      assert.equal(g.body.feedback['own-a'].rating, 'down');
      assert.deepEqual(g.body.feedback['own-a'].tags, ['unhelpful']);
      const stored = await (await memory()).getThreadById({ threadId: 'own' });
      assert.deepEqual(Object.keys(stored.metadata.assistantFeedback), ['own-a']);
      assert.deepEqual(Object.keys(stored.metadata.assistantFeedback['own-a']), ['user-1']);
      assert.equal(stored.metadata.agentId, 'agent-a', 'other metadata is kept');

      assert.deepEqual(
        annotations.map((a) => [a.identifier, a.result.label]),
        [
          ['user:user-1:message:own-a', 'thumbs_up'],
          ['user:user-1:message:own-a', 'thumbs_up'],
          ['user:user-1:message:own-a', 'thumbs_down'],
        ],
      );
    });

    it('per user: another viewer’s reaction is separate and not returned to this viewer', async () => {
      await put('alice', 'own', { messageId: 'own-a', rating: 'up' });
      viewer = 'user-2';
      await put('alice', 'own', { messageId: 'own-a', rating: 'down' });
      assert.equal((await get('alice', 'own')).body.feedback['own-a'].rating, 'down');
      viewer = 'user-1';
      assert.equal((await get('alice', 'own')).body.feedback['own-a'].rating, 'up');
    });

    it('Phoenix unset: stored locally, annotation skipped', async () => {
      phoenixConfigured = false;
      const r = await put('alice', 'own', { messageId: 'own-a', rating: 'down', reason: 'meh' });
      assert.equal(r.status, 200);
      assert.equal(r.body.annotation, 'skipped');
      assert.equal((await get('alice', 'own')).body.feedback['own-a'].reason, 'meh');
      assert.deepEqual(annotations, []);
    });

    it('message without a trace id: stored, annotation skipped without calling Phoenix', async () => {
      const r = await put('alice', 'untraced', { messageId: 'untraced-a', rating: 'up' });
      assert.equal(r.status, 200);
      assert.equal(r.body.annotation, 'skipped');
      assert.deepEqual(annotations, []);
      assert.equal((await get('alice', 'untraced')).body.feedback['untraced-a'].rating, 'up');
    });

    it('Phoenix failure does not fail the save', async () => {
      phoenixOutcome = 'failed';
      const r = await put('alice', 'own', { messageId: 'own-a', rating: 'up' });
      assert.equal(r.status, 200);
      assert.equal(r.body.annotation, 'failed');
      assert.equal((await get('alice', 'own')).body.feedback['own-a'].rating, 'up');
    });
  });
});
