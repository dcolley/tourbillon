/**
 * STEER-1 acceptance: real Mastra AgentController + Memory on an in-memory store, slow mock model.
 * Send A, steer B mid-run: the steer run's model prompt must still carry A (and B), once each.
 *
 * The store adds a few ms to message writes, as Postgres does. Without that the in-memory store saves
 * the aborted run's user message synchronously enough that the race behind STEER-1 never shows.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { steerPreservingTurn, trackInFlightUserTurns, type SteerableSession } from './steer-preserving-turn';

const mastraRequire = createRequire(join(__dirname, '../../../../packages/mastra/package.json'));

type Prompt = Array<{ role: string; content: unknown }>;

const WRITE_LATENCY_MS = 5;

async function harness() {
  const { AgentController } = mastraRequire('@mastra/core/agent-controller');
  const { Agent } = mastraRequire('@mastra/core/agent');
  const { MastraLanguageModelV2Mock } = mastraRequire('@mastra/core/test-utils/llm-mock');
  const { InMemoryStore } = mastraRequire('@mastra/core/storage');
  const { Memory } = mastraRequire('@mastra/memory');

  const prompts: Prompt[] = [];
  let calls = 0;
  let firstCallStarted!: () => void;
  const firstCall = new Promise<void>((resolve) => (firstCallStarted = resolve));
  const model = new MastraLanguageModelV2Mock({
    doStream: async ({ prompt, abortSignal }: { prompt: Prompt; abortSignal?: AbortSignal }) => {
      calls += 1;
      const n = calls;
      prompts.push(prompt);
      const id = `t${n}`;
      const stream = new ReadableStream({
        async start(c) {
          c.enqueue({ type: 'stream-start', warnings: [] });
          c.enqueue({ type: 'text-start', id });
          c.enqueue({ type: 'text-delta', id, delta: `reply ${n}` });
          if (n === 1) {
            firstCallStarted();
            // Slow model: the first turn only ends when it is aborted (or after 10 s).
            await new Promise<void>((resolve) => {
              const t = setTimeout(resolve, 10_000);
              abortSignal?.addEventListener('abort', () => {
                clearTimeout(t);
                resolve();
              });
            });
            if (abortSignal?.aborted) {
              c.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
              return;
            }
          }
          c.enqueue({ type: 'text-end', id });
          c.enqueue({ type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
          c.close();
        },
      });
      return { stream, rawCall: { rawPrompt: null, rawSettings: {} } };
    },
  });

  const storage = new InMemoryStore();
  const memoryStore = await storage.getStore('memory');
  const save = memoryStore.saveMessages.bind(memoryStore);
  memoryStore.saveMessages = async (args: unknown) => {
    await new Promise((r) => setTimeout(r, WRITE_LATENCY_MS));
    return save(args);
  };

  const controller = new AgentController({
    id: 'steer1-controller',
    storage,
    memory: new Memory({ storage, options: { lastMessages: 20, semanticRecall: false } }),
    agent: new Agent({ id: 'steer1-agent', name: 'Steer1', instructions: 'Test agent.', model }),
    modes: [{ id: 'default', name: 'Default', default: true, defaultModelId: 'stub/stub' }],
    initialState: { yolo: true },
  });
  await controller.init();
  const session = await controller.createSession({ resourceId: 'company-1:chat:free', id: 'steer1', ownerId: controller.id });
  await session.thread.create({});
  const threadId: string = session.thread.getId();
  return { session, threadId, prompts, firstCall, calls: () => calls };
}

function promptText(prompt: Prompt | undefined): string {
  return JSON.stringify(prompt ?? []);
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

async function waitFor(check: () => boolean, ms = 5_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function idle(session: { getCurrentRunId(): unknown }): Promise<void> {
  await waitFor(() => !session.getCurrentRunId());
  await new Promise((r) => setTimeout(r, 100)); // let the aborted run's late writes land
}

describe('STEER-1 steer mid-run (real Mastra, slow model, async store)', () => {
  it('root cause: plain session.steer() starts the steer run without the interrupted message', async () => {
    const h = await harness();
    const first = h.session.sendMessage({ content: 'ORIGINAL A' }).catch(() => {});
    await h.firstCall;
    await h.session.steer({ content: 'STEER B' });
    await waitFor(() => h.calls() >= 2);
    await first;
    await idle(h.session);
    const second = promptText(h.prompts[1]);
    assert.ok(second.includes('STEER B'));
    assert.ok(
      !second.includes('ORIGINAL A'),
      'Mastra now keeps the interrupted message on steer by itself; steerPreservingTurn may no longer be needed',
    );
  });

  it('steerPreservingTurn: the steer run prompt has A and B once each; A is stored once', async () => {
    const h = await harness();
    trackInFlightUserTurns(h.session as unknown as SteerableSession);
    const first = h.session.sendMessage({ content: 'ORIGINAL A' }).catch(() => {});
    await h.firstCall;

    const result = await steerPreservingTurn(h.session as unknown as SteerableSession, { content: 'STEER B' });
    await waitFor(() => h.calls() >= 2);
    await first;
    await idle(h.session);

    assert.equal(result.persisted.length, 1, 'the interrupted user turn was saved before the steer');
    assert.equal(result.inlined.length, 0);
    const second = promptText(h.prompts[1]);
    assert.equal(occurrences(second, 'ORIGINAL A'), 1, `A once in the steer prompt: ${second}`);
    assert.equal(occurrences(second, 'STEER B'), 1, `B once in the steer prompt: ${second}`);
    assert.ok(second.indexOf('ORIGINAL A') < second.indexOf('STEER B'), 'A before B');

    const stored = (await h.session.thread.listMessages({ threadId: h.threadId })) as Array<{ id: string; content: unknown }>;
    const withA = stored.filter((m) => JSON.stringify(m.content).includes('ORIGINAL A'));
    assert.equal(withA.length, 1, 'no duplicate of A after the aborted run also saves it');
    assert.equal(stored.filter((m) => JSON.stringify(m.content).includes('STEER B')).length, 1);
  });

  it('a later steer (after the steer run finished) keeps A and B, nothing twice', async () => {
    const h = await harness();
    trackInFlightUserTurns(h.session as unknown as SteerableSession);
    const first = h.session.sendMessage({ content: 'ORIGINAL A' }).catch(() => {});
    await h.firstCall;
    await steerPreservingTurn(h.session as unknown as SteerableSession, { content: 'STEER B' });
    await waitFor(() => h.calls() >= 2);
    await first;
    await idle(h.session);

    await steerPreservingTurn(h.session as unknown as SteerableSession, { content: 'STEER C' });
    await waitFor(() => h.calls() >= 3);
    await idle(h.session);
    const third = promptText(h.prompts[2]);
    for (const text of ['ORIGINAL A', 'STEER B', 'STEER C']) {
      assert.equal(occurrences(third, text), 1, `${text} once in the third prompt: ${third}`);
    }
  });
});
