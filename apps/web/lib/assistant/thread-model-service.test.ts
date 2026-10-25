/**
 * CHAT-5: saving a thread's model choice — refused for providers that are off or unknown, while a
 * run is open, for archived agents and for effort levels the model does not support. The state
 * lists only enabled providers.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  ThreadModelError,
  saveThreadModelChoice,
  threadModelState,
  type ThreadModelDeps,
} from './thread-model-service';
import type { ThreadModelChoice } from './thread-model';

const AGENT = { id: 'a1', companyId: 'c1', modelId: 'agent/model', providerId: 'p-on', status: 'active' };

let writes: Array<[string, ThreadModelChoice | null]>;
let runOpen: boolean;
let writeResult: boolean;
const listed: string[] = [];

const deps: ThreadModelDeps = {
  listProviders: async (companyId) => {
    listed.push(companyId);
    return [
      { id: 'p-on', name: 'Cloud', type: 'openai', enabledForCompany: true },
      { id: 'p-off', name: 'Off', type: 'openai', enabledForCompany: false },
      { id: 'p-lm', name: 'Local', type: 'lmstudio', enabledForCompany: true },
    ];
  },
  effectiveAgentProviderId: async (_c, providerId) => providerId ?? null,
  isRunOpen: () => runOpen,
  writeChoice: async (threadId, choice) => {
    writes.push([threadId, choice]);
    return writeResult;
  },
};

async function refusal(p: Promise<unknown>): Promise<ThreadModelError> {
  try {
    await p;
  } catch (err) {
    assert.ok(err instanceof ThreadModelError, String(err));
    return err;
  }
  assert.fail('expected a refusal');
}

describe('CHAT-5 thread model service', () => {
  beforeEach(() => {
    writes = [];
    runOpen = false;
    writeResult = true;
    listed.length = 0;
  });

  it('state: enabled providers only, agent default, stored choice and availability', async () => {
    const none = await threadModelState(AGENT, { agentId: 'a1' }, deps);
    assert.deepEqual(listed, ['c1'], "scoped to the agent's company");
    assert.equal(none.choice, null);
    assert.equal(none.choiceAvailable, true);
    assert.deepEqual(none.providers.map((p) => p.id), ['p-on', 'p-lm']);
    assert.deepEqual(none.agentDefault, { providerId: 'p-on', providerName: 'Cloud', modelId: 'agent/model' });
    assert.doesNotMatch(JSON.stringify(none), /baseURL|apiKey|headers/);

    const gone = await threadModelState(AGENT, { assistantModel: { providerId: 'p-off', modelId: 'm' } }, deps);
    assert.deepEqual(gone.choice, { providerId: 'p-off', modelId: 'm' });
    assert.equal(gone.choiceAvailable, false);
    assert.ok(!gone.providers.some((p) => p.id === 'p-off'));
  });

  it('saves a valid choice (with a supported effort) and clears it', async () => {
    assert.deepEqual(
      await saveThreadModelChoice(AGENT, 't1', { providerId: 'p-on', modelId: 'openai/gpt-5', reasoningLevel: 'high' }, deps),
      { providerId: 'p-on', modelId: 'openai/gpt-5', reasoningLevel: 'high' },
    );
    assert.equal(await saveThreadModelChoice(AGENT, 't1', null, deps), null);
    assert.deepEqual(writes, [
      ['t1', { providerId: 'p-on', modelId: 'openai/gpt-5', reasoningLevel: 'high' }],
      ['t1', null],
    ]);
  });

  it('refuses a provider that is off or unknown (409 provider_disabled_for_company), writes nothing', async () => {
    for (const providerId of ['p-off', 'p-missing']) {
      const err = await refusal(saveThreadModelChoice(AGENT, 't1', { providerId, modelId: 'm' }, deps));
      assert.equal(err.status, 409);
      assert.equal(err.code, 'provider_disabled_for_company');
    }
    assert.equal(writes.length, 0);
  });

  it('refuses while a run is open, and for an archived agent', async () => {
    runOpen = true;
    const busy = await refusal(saveThreadModelChoice(AGENT, 't1', { providerId: 'p-on', modelId: 'm' }, deps));
    assert.equal(busy.status, 409);
    assert.equal(busy.code, 'run_in_progress');
    runOpen = false;
    const archived = await refusal(saveThreadModelChoice({ ...AGENT, status: 'archived' }, 't1', null, deps));
    assert.equal(archived.status, 409);
    assert.equal(writes.length, 0);
  });

  it('refuses an effort the model does not support (LM Studio levels come from the provider)', async () => {
    const err = await refusal(
      saveThreadModelChoice(AGENT, 't1', { providerId: 'p-on', modelId: 'llama-3.1-8b', reasoningLevel: 'high' }, deps),
    );
    assert.equal(err.status, 400);
    assert.equal(writes.length, 0);
    await saveThreadModelChoice(AGENT, 't1', { providerId: 'p-lm', modelId: 'local-model', reasoningLevel: 'high' }, deps);
    assert.equal(writes.length, 1);
  });

  it('a thread outside the scope → 404', async () => {
    writeResult = false;
    const err = await refusal(saveThreadModelChoice(AGENT, 't1', { providerId: 'p-on', modelId: 'm' }, deps));
    assert.equal(err.status, 404);
  });
});
