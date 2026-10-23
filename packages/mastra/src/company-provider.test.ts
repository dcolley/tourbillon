/** PRV-1 resolver: enabled, disabled with fallback (+ activity warning), none enabled. No DB. */
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

process.env.DATABASE_URL ??= 'postgres://user:pass@127.0.0.1:5432/unused';

type Mod = typeof import('./company-provider');
type Db = typeof import('@tourbillon/db');

const row = (id: string, name: string, isDefault = false) =>
  ({
    id, name, type: 'openai-compatible', baseURL: `http://${id}.test/v1`, apiKey: null, headers: {},
    apiMode: 'chat', defaultModelSettings: {}, defaultModel: null, isDefault, stickiness: 'off',
    stickinessHeaderName: 'x-litellm-session-id', createdAt: new Date(0), updatedAt: new Date(0),
  }) as unknown as import('@tourbillon/db').LlmProvider;

const agent = { id: 'agent-1', name: 'Writer', companyId: 'co-a', providerId: 'p-local' };

describe('resolveAgentProviderRow', () => {
  let mod: Mod;
  let dbMod: Db;
  before(async () => {
    mod = await import('./company-provider');
    dbMod = await import('@tourbillon/db');
  });

  it('enabled provider → used, no warning', async () => {
    const recorded: unknown[] = [];
    const warned: string[] = [];
    const res = await mod.resolveAgentProviderRow(agent, { context: 'heartbeat', recordWarning: true }, {
      resolve: async () => ({ row: row('p-local', 'Local'), fallbackFrom: null }),
      record: async (input) => void recorded.push(input),
      warn: (l) => void warned.push(l),
    });
    assert.equal(res.row?.id, 'p-local');
    assert.equal(res.fallbackFrom, null);
    assert.equal(recorded.length, 0);
    assert.equal(warned.length, 0);
  });

  it('disabled provider → company default, warning recorded with run id', async () => {
    const recorded: Array<Parameters<Db['recordLlmProviderFallback']>[0]> = [];
    const warned: string[] = [];
    const res = await mod.resolveAgentProviderRow(
      agent,
      { context: 'heartbeat', recordWarning: true, runId: 'run-9' },
      {
        resolve: async (companyId, providerId) => {
          assert.equal(companyId, 'co-a');
          assert.equal(providerId, 'p-local');
          return { row: row('p-default', 'Default', true), fallbackFrom: row('p-local', 'Local') };
        },
        record: async (input) => void recorded.push(input),
        warn: (l) => void warned.push(l),
      },
    );
    assert.equal(res.row?.id, 'p-default');
    assert.equal(res.fallbackFrom?.id, 'p-local');
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].from.id, 'p-local');
    assert.equal(recorded[0].to.id, 'p-default');
    assert.equal(recorded[0].context, 'heartbeat');
    assert.equal(recorded[0].runId, 'run-9');
    assert.equal(warned.length, 1);
  });

  it('fallback without recordWarning → trace only, no activity row', async () => {
    const recorded: unknown[] = [];
    const warned: string[] = [];
    await mod.resolveAgentProviderRow(agent, { context: 'chat' }, {
      resolve: async () => ({ row: row('p-default', 'Default', true), fallbackFrom: row('p-local', 'Local') }),
      record: async (input) => void recorded.push(input),
      warn: (l) => void warned.push(l),
    });
    assert.equal(recorded.length, 0);
    assert.equal(warned.length, 1);
  });

  it('activity write failing does not fail the run', async () => {
    const warned: string[] = [];
    const res = await mod.resolveAgentProviderRow(agent, { context: 'chat', recordWarning: true }, {
      resolve: async () => ({ row: row('p-default', 'Default', true), fallbackFrom: row('p-local', 'Local') }),
      record: async () => {
        throw new Error('db down');
      },
      warn: (l) => void warned.push(l),
    });
    assert.equal(res.row?.id, 'p-default');
    assert.equal(warned.length, 2);
  });

  it('none enabled → NoEnabledLlmProviderError surfaces', async () => {
    await assert.rejects(
      mod.resolveAgentProviderRow(agent, { context: 'heartbeat', recordWarning: true }, {
        resolve: async () => {
          throw new dbMod.NoEnabledLlmProviderError('co-a', 'p-local');
        },
        record: async () => undefined,
        warn: () => undefined,
      }),
      (err: unknown) =>
        err instanceof dbMod.NoEnabledLlmProviderError &&
        /No LLM provider is enabled for this company/.test(err.message),
    );
  });
});
