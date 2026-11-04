/**
 * S332-S2 pin (gate #332 soft): the REAL `realDeliver` controller adapter must key the
 * live-session lookup with `chatSessionId(resourceId, scope)`.
 *
 * The bridge suite injects a fake `getSessionByResource` at the `DeliverDeps` seam, so the
 * production adapter (task-progress-bridge.ts, `realDeliverGetOrCreateChatController`) had
 * no coverage: gate mutant S6 (adapter back to `controller.getSession(resourceId)`, scope
 * dropped) stayed GREEN across every suite while the bridge would have looked up (and
 * delivered to) the wrong session in production.
 *
 * These pins call the EXPORTED adapter through its `loadChat` test seam with a fake chat
 * module, and keep `chatSessionId` REAL (it is a static leaf import in the bridge - no mock
 * can swap it), so any regression of the Mastra 1.81 keying - dropping the scope, the
 * `::` separator, or the helper itself - flips RED here. A structural pin asserts
 * `realDeliver` is wired to this exact function and the seam default is still
 * `() => import('@/lib/chat')`, so neither a re-inlined private copy nor a rewired default
 * silently un-pins the adapter.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TaskProgressAgentRecord } from './task-progress-signals';
import { realDeliverGetOrCreateChatController } from './task-progress-bridge';

const AGENT = {
  id: 'agent-1',
  companyId: 'company-1',
  status: 'active',
  companyStatus: 'active',
} as unknown as TaskProgressAgentRecord;

function fakeChatModule(getSession: (sessionId: string) => Promise<unknown>) {
  return async () => ({
    getOrCreateChatController: async (_agent: unknown) => ({ getSession }),
  });
}

describe('S332-S2: realDeliver controller adapter keys live-session lookup with chatSessionId', () => {
  it('getSessionByResource passes chatSessionId(resourceId, scope) to controller.getSession', async () => {
    const seen: string[] = [];
    const fakeSession = { marker: 'session-under-resource-and-scope' };
    const adapter = await realDeliverGetOrCreateChatController(
      AGENT,
      fakeChatModule(async (sessionId: string) => {
        seen.push(sessionId);
        return fakeSession;
      }) as never,
    );

    const got = await adapter.getSessionByResource('res-1', 'agui:agent-1');
    // Real chatSessionId: `resourceId::scope`. Dropping the scope (gate mutant S6),
    // collapsing `::` to `:`, or passing the raw pair all land RED on this assert.
    assert.deepEqual(seen, ['res-1::agui:agent-1'], 'adapter must look up by chatSessionId(resourceId, scope)');
    assert.equal(got, fakeSession, 'adapter must return what controller.getSession returned');
  });

  it('without a scope the id is the bare resourceId (chatSessionId contract)', async () => {
    const seen: string[] = [];
    const adapter = await realDeliverGetOrCreateChatController(
      AGENT,
      fakeChatModule(async (sessionId: string) => {
        seen.push(sessionId);
        return undefined;
      }) as never,
    );

    const got = await adapter.getSessionByResource('res-1', undefined as unknown as string);
    assert.deepEqual(seen, ['res-1'], 'scopeless lookup must be the bare resourceId');
    assert.equal(got, undefined, 'missing session stays undefined (real Mastra contract)');
  });

  it('structural: realDeliver is wired to the exported adapter; seam default is the real @/lib/chat', () => {
    const src = readFileSync(join(__dirname, 'task-progress-bridge.ts'), 'utf8');
    // The createDeliver(...) deps must reference the exported function BY NAME. Re-inlining
    // the closure here would hand realDeliver an untested adapter - RED on this pin.
    assert.match(
      src,
      /createDeliver\(\{[\s\S]*?getOrCreateChatController:\s*realDeliverGetOrCreateChatController[\s\S]*?\}\)/,
      'realDeliver must wire getOrCreateChatController to the exported, pinned adapter',
    );
    // The default loader must still be the production chat barrel, not a stubbed module.
    assert.match(
      src,
      /loadChat:\s*\(\)\s*=>\s*Promise<[^>]*>\s*=\s*\(\)\s*=>\s*import\('@\/lib\/chat'\)/,
      'loadChat seam must default to the real @/lib/chat import',
    );
    // And the pinned implementation itself must keep the 1.81 keying line.
    assert.match(
      src,
      /controller\.getSession\(\s*chatSessionId\(\s*resourceId,\s*scope\s*\)\s*\)/,
      'adapter body must call controller.getSession(chatSessionId(resourceId, scope))',
    );
  });
});
