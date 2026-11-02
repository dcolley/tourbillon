/**
 * S297-S1 (Refs #297): action-level pin for updateAvatarConfig (the AGENT-AVATAR-UI save action).
 *
 * The #297 gate found the action unpinned: deleting the `if (!parsed) return actionError(...)`
 * guard survived every existing test — an invalid posted shape/colour then fell through to
 * updateAgentAvatar(agentId, null) and silently RESET the avatar instead of refusing. These tests
 * run the real action: @tourbillon/shared/agent-avatar stays real (that is the validator under
 * test); next/cache, @/lib/company and @/lib/agents are faked via Module.prototype.require (same
 * idiom as agent-active-action.test.ts) so every write is observable and asserted.
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { ActionResult } from '@/lib/action-result';

class MockAgentValidationError extends Error {
  override name = 'AgentValidationError';
}

let writes: Array<[string, unknown]>;
let revalidated: string[];
let guardCalls: number;
let failNext: Error | null;

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

describe('S297-S1 updateAvatarConfig shape/colour guard', () => {
  let updateAvatarConfig: (prev: ActionResult | null, formData: FormData) => Promise<ActionResult>;

  before(async () => {
    const Module = require('module');
    const originalRequire = Module.prototype.require;
    Module.prototype.require = function (this: unknown, id: string) {
      if (id === 'next/cache') return { revalidatePath: (p: string) => revalidated.push(p) };
      if (id === '@/lib/company') return { requireBoardSession: async () => { guardCalls += 1; } };
      if (id === '@/lib/agents') {
        return {
          AgentValidationError: MockAgentValidationError,
          updateAgentAvatar: async (agentId: string, avatar: unknown) => {
            if (failNext) throw failNext;
            writes.push([agentId, avatar]);
          },
        };
      }
      return originalRequire.apply(this, arguments as unknown as [string]);
    };
    ({ updateAvatarConfig } = await import('./update-avatar-action'));
  });

  beforeEach(() => {
    writes = [];
    revalidated = [];
    guardCalls = 0;
    failNext = null;
  });

  const base = { agentId: 'agent-1', urlKey: 'ceo' };

  it('valid shape + colour: writes the parsed config, revalidates, reports saved', async () => {
    const res = await updateAvatarConfig(null, form({ ...base, shape: 'blob-3', color: 'teal' }));
    assert.deepEqual(res, { ok: true, message: 'Avatar saved.' });
    assert.deepEqual(writes, [['agent-1', { shape: 'blob-3', color: '#14b8a6' }]], 'the palette id resolves to its exact hex');
    assert.deepEqual(revalidated, ['/agent/ceo']);
  });

  it('invalid shape (valid colour): error, NO write, no revalidate — the deleted-guard mutant lands here', async () => {
    const res = await updateAvatarConfig(null, form({ ...base, shape: 'squircle', color: 'teal' }));
    assert.equal(res.ok, false);
    assert.match((res as { error: string }).error, /Pick a shape and a colour/);
    assert.deepEqual(writes, [], 'an invalid shape must never reach updateAgentAvatar (not even as null = reset)');
    assert.deepEqual(revalidated, []);
  });

  it('invalid colour (valid shape): error, NO write, no revalidate', async () => {
    const res = await updateAvatarConfig(null, form({ ...base, shape: 'circle', color: 'chartreuse' }));
    assert.equal(res.ok, false);
    assert.match((res as { error: string }).error, /Pick a shape and a colour/);
    assert.deepEqual(writes, []);
    assert.deepEqual(revalidated, []);
  });

  it('off-palette hex colour is invalid too (the parser is a fixed-set whitelist)', async () => {
    for (const color of ['#00ff00', '#14B8A6']) {
      writes = [];
      const res = await updateAvatarConfig(null, form({ ...base, shape: 'circle', color }));
      assert.equal(res.ok, false, color);
      assert.deepEqual(writes, [], color);
    }
  });

  it('both fields blank: legitimate reset — updateAgentAvatar(null), reset message', async () => {
    const res = await updateAvatarConfig(null, form({ ...base, shape: '  ', color: '' }));
    assert.deepEqual(res, { ok: true, message: 'Avatar reset to default.' });
    assert.deepEqual(writes, [['agent-1', null]]);
    assert.deepEqual(revalidated, ['/agent/ceo']);
  });

  it('missing agentId or urlKey: Missing agent., guard runs first, no write', async () => {
    for (const fields of [{ agentId: '', urlKey: 'ceo' }, { agentId: 'agent-1', urlKey: '' }]) {
      writes = [];
      const res = await updateAvatarConfig(null, form({ ...fields, shape: 'circle', color: 'teal' }));
      assert.deepEqual(res, { ok: false, error: 'Missing agent.' });
      assert.deepEqual(writes, []);
    }
    assert.ok(guardCalls >= 1, 'the board-session guard runs before any parsing');
  });

  it('AgentValidationError passes its message through; a generic error stays generic', async () => {
    failNext = new MockAgentValidationError('Agent not found.');
    assert.deepEqual(await updateAvatarConfig(null, form({ ...base, shape: 'circle', color: 'teal' })), {
      ok: false,
      error: 'Agent not found.',
    });
    failNext = new Error('db exploded: postgres://user:***@host');
    assert.deepEqual(await updateAvatarConfig(null, form({ ...base, shape: 'circle', color: 'teal' })), {
      ok: false,
      error: 'Failed to save avatar.',
    });
    assert.deepEqual(writes, []);
    assert.deepEqual(revalidated, []);
  });
});
