/**
 * S332-S1 pin (gate #332 soft): nothing exercised the REAL `registry.getChatSession`'s
 * session id. Route tests mock `@/lib/chat` wholesale and mirror the keying inside the
 * test file, so a regression back to `id: threadId ?? chatSessionId(...)` (pre-1.81
 * keying) stayed GREEN across the whole suite — while active-thread, threads and the
 * task-progress bridge (all `getSession(chatSessionId(resourceId, scope))` consumers)
 * would silently miss the session in production.
 *
 * This pin calls the REAL registry `getChatSession` against a REAL Mastra AgentController
 * (in-memory storage, stub model — same pattern as chat-route-scoping.test.ts) and
 * asserts the created session's id is exactly `chatSessionId(resourceId, scope)` =
 * `resource::scope`, and that the 1.81 lookup contract `controller.getSession(id)`
 * finds THAT session. `threadId` must only choose the thread, never the id.
 *
 * Mutation coverage (verified when this soft landed):
 *   - `id: threadId ?? chatSessionId(resourceId, scope)`  -> RED (id becomes the thread id)
 *   - session-id.ts `::` -> `:`                            -> RED
 *   - session-id.ts dropping the scope suffix              -> RED
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';

// registry.getChatSession -> createChatRequestContext mints a chat-scoped agent token,
// which demands a configured signing secret. Deterministic test-only value (never used
// outside this process); same convention as the agent-token auth tests.
process.env.TOURBILLON_AGENT_TOKEN_SECRET ??= 's332-s1-pin-secret-0123456789abcdef0123456789abcdef';

const mastraRequire = createRequire(join(__dirname, '../../../../packages/mastra/package.json'));

const COMPANY_ID = 'company-a';
const AGENT_ID = 'agent-s1';
const SCOPE = 'agui:agent-s1';
// Must match buildChatResourceId(companyId, {}) — the free-chat resource the registry
// derives when no issue tags are present (see chat-route-scoping.test.ts RES_A).
const EXPECTED_RESOURCE = `company-${COMPANY_ID}:chat:free`;

function stubModel() {
  const { MastraLanguageModelV2Mock } = mastraRequire('@mastra/core/test-utils/llm-mock');
  return new MastraLanguageModelV2Mock({
    doStream: async () => {
      throw new Error('S332-S1: no model call expected — this pin only creates sessions');
    },
  });
}

describe('S332-S1: real registry.getChatSession ids sessions as chatSessionId(resourceId, scope)', () => {
  let controller: any;
  let agentRecord: any;
  let getChatSession: typeof import('./registry').getChatSession;
  let chatSessionId: typeof import('./session-id').chatSessionId;

  before(async () => {
    const { AgentController } = mastraRequire('@mastra/core/agent-controller');
    const { Agent } = mastraRequire('@mastra/core/agent');

    const agent = new Agent({
      id: AGENT_ID,
      name: 'S1 agent',
      instructions: 'S332-S1 pin agent',
      model: stubModel(),
    });
    controller = new AgentController({
      id: `s1-controller-${AGENT_ID}`,
      resourceId: EXPECTED_RESOURCE,
      agent,
      modes: [{ id: 'default', name: 'Default' }],
    });
    agentRecord = {
      id: AGENT_ID,
      companyId: COMPANY_ID,
      name: 'S1 agent',
      status: 'active',
      runtimeConfig: {},
    };

    ({ getChatSession } = await import('./registry'));
    ({ chatSessionId } = await import('./session-id'));
  });

  it('scoped session id is `resource::scope` and threadId only picks the thread', async () => {
    const session = await getChatSession(controller, agentRecord, {
      scope: SCOPE,
      threadId: 'thread-pin-1',
    });

    const expectedId = `${EXPECTED_RESOURCE}::${SCOPE}`;
    assert.equal(
      session.identity.getId(),
      expectedId,
      'session.id must be chatSessionId(resourceId, scope) — never the threadId (S332-S1)',
    );
    // The 1.81 lookup contract every consumer relies on (active-thread, threads, bridge):
    assert.equal(
      await controller.getSession(expectedId),
      session,
      'controller.getSession(chatSessionId(resourceId, scope)) must return this session',
    );
    assert.equal(session.thread.getId(), 'thread-pin-1', 'threadId binds the thread, not the id');
  });

  it('same (resource, scope) with a second threadId lands on the same session id', async () => {
    const first = await getChatSession(controller, agentRecord, { scope: SCOPE, threadId: 'thread-a' });
    const second = await getChatSession(controller, agentRecord, { scope: SCOPE, threadId: 'thread-b' });
    assert.equal(first.identity.getId(), second.identity.getId(), 'the session id is (resource, scope)-keyed, not thread-keyed');
    assert.equal(first.identity.getId(), chatSessionId(EXPECTED_RESOURCE, SCOPE));
  });

  it('scopeless session id is the bare resourceId', async () => {
    const session = await getChatSession(controller, agentRecord, { threadId: 'thread-noscope' });
    assert.equal(session.identity.getId(), EXPECTED_RESOURCE, 'no scope -> id is the bare resourceId');
    assert.equal(await controller.getSession(EXPECTED_RESOURCE), session);
  });
});
