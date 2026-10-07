/**
 * Repeated-tool loop breaker in driveSessionHeadless: trips only on 5 consecutive
 * tool_start events with the same tool name AND the same canonical args hash.
 *
 * (a), (c) and (d) fail on the old name-only breaker; (b) and (e) pass on both.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import type { AgentControllerEvent } from '@tourbillon/mastra';
import { driveSessionHeadless } from './harness-session-drive';

type ToolCall = { toolName: string; args?: unknown };

interface DriveOutcome {
  finishReason: string;
  abortCalled: boolean;
  /** 1-based index of the tool_start that tripped the breaker, or null. */
  trippedAt: number | null;
  errorMessages: string[];
}

async function driveToolCalls(calls: ToolCall[]): Promise<DriveOutcome> {
  const listeners = new Set<(event: AgentControllerEvent) => void>();
  let abortCalled = false;
  let emitted = 0;
  let trippedAt: number | null = null;
  const errorMessages: string[] = [];

  const session = {
    subscribe(listener: (event: AgentControllerEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    abort() {
      if (!abortCalled) trippedAt = emitted;
      abortCalled = true;
    },
    getCurrentRunId() {
      return null;
    },
    run: { isRunning: () => !abortCalled },
    sendMessage: async () => {
      for (const call of calls) {
        if (abortCalled) return;
        emitted += 1;
        for (const listener of [...listeners]) {
          listener({
            type: 'tool_start',
            toolCallId: `call-${emitted}`,
            toolName: call.toolName,
            args: call.args,
          } as AgentControllerEvent);
        }
      }
      if (abortCalled) return;
      for (const listener of [...listeners]) {
        listener({ type: 'agent_end', reason: 'complete' } as AgentControllerEvent);
      }
    },
  };

  const result = await driveSessionHeadless(
    session as never,
    'wake',
    {},
    (event) => {
      if (event.type === 'error') errorMessages.push(event.error.message);
    },
    undefined,
    undefined,
    60,
  );
  return { finishReason: result.finishReason, abortCalled, trippedAt, errorMessages };
}

const repeat = (n: number, call: ToolCall): ToolCall[] => Array.from({ length: n }, () => call);

describe('repeated tool loop breaker (name + args hash)', () => {
  it('(a) same tool with different args 5+ times in a row does not trip', async () => {
    const calls = Array.from({ length: 8 }, (_, i) => ({
      toolName: 'readWorkspaceFileTool',
      args: { path: `projects/file-${i}.md` },
    }));
    const outcome = await driveToolCalls(calls);
    assert.equal(outcome.abortCalled, false);
    assert.equal(outcome.finishReason, 'complete');
    assert.deepEqual(outcome.errorMessages, []);
  });

  it('(b) same tool + identical args 5 times trips on the 5th with unchanged reason/message', async () => {
    const outcome = await driveToolCalls(
      repeat(7, { toolName: 'searxngSearch', args: { query: 'tourbillon', limit: 5 } }),
    );
    assert.equal(outcome.finishReason, 'repeated_tool_loop');
    assert.equal(outcome.abortCalled, true);
    assert.equal(outcome.trippedAt, 5);
    assert.deepEqual(outcome.errorMessages, [
      'Repeated tool loop detected: searxngSearch called 5 times in a row',
    ]);

    const four = await driveToolCalls(
      repeat(4, { toolName: 'searxngSearch', args: { query: 'tourbillon', limit: 5 } }),
    );
    assert.equal(four.abortCalled, false, '4 identical calls stay under the threshold');
    assert.equal(four.finishReason, 'complete');
  });

  it('(b2) canonical args: key order at every depth and undefined-valued keys do not change the hash', async () => {
    const variants: unknown[] = [
      { q: 'x', opts: { limit: 10, filters: { b: 2, a: 1 } } },
      { opts: { filters: { a: 1, b: 2 }, limit: 10 }, q: 'x' },
      { q: 'x', cursor: undefined, opts: { limit: 10, filters: { a: 1, b: 2, c: undefined } } },
      { opts: { limit: 10, filters: { b: 2, a: 1 }, extra: undefined }, q: 'x' },
      { q: 'x', opts: { filters: { a: 1, b: 2 }, limit: 10 } },
    ];
    const outcome = await driveToolCalls(variants.map((args) => ({ toolName: 'listApprovalsTool', args })));
    assert.equal(outcome.finishReason, 'repeated_tool_loop');
    assert.equal(outcome.trippedAt, 5);
  });

  it('(c) a different-args call resets the streak (4 same, 1 different, 4 same) and does not trip', async () => {
    const same = { toolName: 'getCommentsTool', args: { issueId: 'issue-1' } };
    const other = { toolName: 'getCommentsTool', args: { issueId: 'issue-1', after: 'c-9' } };
    const outcome = await driveToolCalls([...repeat(4, same), other, ...repeat(4, same)]);
    assert.equal(outcome.abortCalled, false);
    assert.equal(outcome.finishReason, 'complete');

    // A different tool in between also resets (same as before).
    const interleaved = await driveToolCalls([
      ...repeat(4, same),
      { toolName: 'getInboxTool', args: {} },
      ...repeat(4, same),
    ]);
    assert.equal(interleaved.abortCalled, false);
  });

  it('(c2) nested value differences produce a different hash (no trip)', async () => {
    const calls = Array.from({ length: 6 }, (_, i) => ({
      toolName: 'listWorkspaceFilesTool',
      args: { path: 'apps/web', opts: { depth: 1, filter: { ext: ['ts'], page: i } } },
    }));
    const outcome = await driveToolCalls(calls);
    assert.equal(outcome.abortCalled, false);
  });

  const fixture = JSON.parse(
    readFileSync(new URL('./__fixtures__/tool-loop-replay.json', import.meta.url), 'utf8'),
  ) as { runs: Record<string, { heartbeatRunErrorText: string; toolStarts: ToolCall[] }> };

  const FALSE_POSITIVE_RUNS = [
    '153999d0-2a44-44f3-8a4c-3298bfc727ba',
    '99d2a8e1-75dc-4ddf-b0de-ba31ad5ce609',
    'd1a4d5ed-456d-44f6-9155-905ec8045318',
    'e357a53c-ada7-441a-b509-ef7c3fff5d76',
  ];

  for (const runId of FALSE_POSITIVE_RUNS) {
    it(`(d) replay ${runId.slice(0, 8)}: same tool, distinct args (old breaker false positive) does not trip`, async () => {
      const run = fixture.runs[runId];
      assert.ok(run, `fixture run ${runId} present`);
      assert.match(run.heartbeatRunErrorText, /Repeated tool loop detected/);
      const outcome = await driveToolCalls(run.toolStarts);
      assert.equal(outcome.abortCalled, false, `tripped at call ${outcome.trippedAt}`);
      assert.equal(outcome.finishReason, 'complete');
    });
  }

  it('(e) replay a4a63c99: 5 identical readWorkspaceFileTool {path:"memory.jsonl"} still trips at the same call', async () => {
    const run = fixture.runs['a4a63c99-7837-4b45-b89f-d490ada4d1e1'];
    assert.ok(run, 'fixture run a4a63c99 present');
    assert.equal(run.toolStarts.length, 32);
    const tail = run.toolStarts.slice(-5);
    assert.ok(tail.every((c) => c.toolName === 'readWorkspaceFileTool'));
    assert.ok(tail.every((c) => JSON.stringify(c.args) === JSON.stringify({ path: 'memory.jsonl' })));

    const outcome = await driveToolCalls(run.toolStarts);
    assert.equal(outcome.finishReason, 'repeated_tool_loop');
    assert.equal(outcome.trippedAt, 32, 'trips on the 5th identical memory.jsonl read, as in production');
    assert.deepEqual(outcome.errorMessages, [
      'Repeated tool loop detected: readWorkspaceFileTool called 5 times in a row',
    ]);
  });
});
