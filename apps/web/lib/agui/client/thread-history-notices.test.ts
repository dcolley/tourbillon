/**
 * TB-363 — task-progress NOTICES in the persisted transcript (contract §3 A1/A2/A5/A6/A8/A10/A4.3).
 *
 * Root cause R1 (base bdd1d970): the bridge persists the notice as a Mastra signal row
 * (role 'signal', part type 'data-signal' — confirmed on the INSTALLED @mastra/core 1.81,
 * message-list-DUIXXRZ7.js:640), but chatItemsFromStoredMessages read only `text` /
 * `data-user-message` parts, so the row rendered NOTHING — live and on reload. #354's
 * certification counted the persisted PG row, never the rendered items, which is why it was
 * green while the human saw nothing.
 *
 * The stored shapes here are verbatim what Mastra 1.81 persists for queueSignal'd signals.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chatItemsFromStoredMessages, type StoredThreadMessage } from './thread-history';
import type { AgentChatItem } from './chat-state';

type NoticeItem = Extract<AgentChatItem, { kind: 'notice' }>;

const signalRow = (
  id: string,
  stage: string,
  over: { contents?: string; title?: string; taskId?: string; runId?: string; createdAt?: string } = {},
): StoredThreadMessage => ({
  id,
  role: 'signal',
  content: {
    format: 2,
    parts: [
      {
        type: 'data-signal',
        data: {
          tagName: 'task-progress',
          type: 'reactive',
          contents:
            over.contents ??
            (stage === 'done'
              ? `Background task done: "${over.title ?? 'Ship the runbook'}".`
              : `Background task ${stage} event`),
          attributes: {
            taskId: over.taskId ?? 'task-1',
            runId: over.runId ?? 'run-1',
            stage,
            status: stage === 'failed' ? 'failed' : stage === 'started' ? 'running' : 'succeeded',
            ...(over.title ? { title: over.title } : {}),
          },
        },
      },
    ],
  },
  ...(over.createdAt ? { createdAt: over.createdAt } : {}),
});

const notices = (items: AgentChatItem[]) => items.filter((i): i is NoticeItem => i.kind === 'notice');

describe('TB-363 task-progress notices in stored transcript', () => {
  it('A1: a stored task-progress done signal row renders exactly one visible notice item', () => {
    const items = chatItemsFromStoredMessages([
      signalRow('sig-done-1', 'done', { title: 'Ship the runbook' }),
    ]);
    const n = notices(items);
    assert.equal(n.length, 1, 'exactly one notice item for the stored signal row');
    assert.equal(n[0]!.stage, 'done');
    assert.equal(n[0]!.noticeKind, 'task-progress');
    assert.equal(n[0]!.taskId, 'task-1');
    assert.equal(n[0]!.runId, 'run-1');
    assert.match(n[0]!.text, /done/i);
    assert.match(n[0]!.text, /Ship the runbook/, 'the notice carries the task title');
    assert.ok(!items.some((i) => i.kind === 'user'), 'the signal row is NOT rendered as an empty user turn');
  });

  it('A2: a needs-input notice keeps the full ask and says the human can reply here', () => {
    const ask = 'Pick vendor A or B by Friday, then I continue';
    const items = chatItemsFromStoredMessages([
      signalRow('sig-ask-1', 'waiting_on_user', {
        contents: `Background task "Vendor call" is waiting on the human: ${ask}. Ask them for exactly that; they can reply here, and the task resumes (status pending) when they answer.`,
        title: 'Vendor call',
      }),
    ]);
    const n = notices(items);
    assert.equal(n.length, 1);
    assert.equal(n[0]!.stage, 'waiting_on_user');
    assert.ok(n[0]!.text.includes(ask), 'the full ask survives — never replaced by a generic "needs input"');
    assert.match(n[0]!.text, /reply here/, 'says how to answer (a reply in this thread resumes it)');
  });

  it('A5: a failed task gets a visible FAILED notice with the reason, distinct from needs-input', () => {
    const items = chatItemsFromStoredMessages([
      signalRow('sig-fail-1', 'failed', {
        contents: 'Background task "Nightly sync" FAILED: worker died (exit 137). Report the failure; do NOT present it as waiting on their input.',
        title: 'Nightly sync',
      }),
    ]);
    const n = notices(items);
    assert.equal(n.length, 1);
    assert.equal(n[0]!.stage, 'failed', 'failed stage survives parse (never collapsed to waiting_on_user)');
    assert.match(n[0]!.text, /FAILED/i);
    assert.match(n[0]!.text, /worker died \(exit 137\)/, 'the reason (detail) is in the notice');
  });

  it('A6: notices are their own item kind — a low-detail filter hiding tool+reasoning still shows all four stages', () => {
    const items = chatItemsFromStoredMessages([
      signalRow('s1', 'started'),
      signalRow('s2', 'waiting_on_user', { contents: 'Background task "T" is waiting on the human: which color?. they can reply here' }),
      signalRow('s3', 'needs_review', { contents: 'Background task "T" needs another look.' }),
      signalRow('s4', 'done', { contents: 'Background task done: "T".' }),
      // Interleave real tool + reasoning items so the reference filter has something to hide.
      {
        id: 'a1',
        role: 'assistant',
        content: {
          format: 2,
          parts: [
            { type: 'reasoning', reasoning: '', details: [{ type: 'text', text: 'think' }] },
            { type: 'tool-invocation', toolInvocation: { state: 'result', toolCallId: 'c1', toolName: 'search', args: {}, result: 'ok' } },
          ],
        },
      } as unknown as StoredThreadMessage,
    ]);
    for (const kind of ['started', 'waiting_on_user', 'needs_review', 'done']) {
      assert.ok(notices(items).some((i) => i.stage === kind), `notice for stage ${kind} exists`);
    }
    const lowDetail = items.filter((i) => i.kind !== 'tool' && i.kind !== 'reasoning');
    assert.equal(notices(lowDetail).length, 4, 'the reference low-detail filter (hide tool+reasoning) still shows every notice');
    assert.ok(notices(items).every((i) => typeof i.stage === 'string'), 'each notice carries its stage');
  });

  it('A8: started → needs-input → done render in that order, including same-millisecond events', () => {
    const at = '2026-11-25T09:00:00.000Z';
    const items = chatItemsFromStoredMessages([
      signalRow('o1', 'started', { createdAt: at }),
      signalRow('o2', 'waiting_on_user', { contents: 'waiting: which env? reply here', createdAt: at }),
      signalRow('o3', 'done', { createdAt: at }),
    ]);
    assert.deepEqual(
      notices(items).map((i) => i.stage),
      ['started', 'waiting_on_user', 'done'],
      'stored order is display order; same-ms events do not reorder',
    );
  });

  it('A4.3: the same signal row arriving twice (reload merged with live) yields ONE notice item', () => {
    const row = signalRow('sig-dup', 'done');
    const items = chatItemsFromStoredMessages([row, JSON.parse(JSON.stringify(row))]);
    assert.equal(notices(items).length, 1, 'keyed by stored message id, never append');
  });

  it('A10: root cause R1 — a stored data-signal task-progress row must produce a chat item (was 0 items)', () => {
    const items = chatItemsFromStoredMessages([signalRow('sig-r1', 'done')]);
    assert.ok(
      items.length >= 1,
      'ROOT CAUSE R1 (apps/web/lib/agui/client/thread-history.ts userText/role-signal path): stored data-signal row produced 0 chat items',
    );
    assert.equal(notices(items).length, 1, 'the item is a notice rendered FROM the signal itself, not a model reply');
  });

  it('A9: the REAL Mastra 1.81 stored shape (text part + content.metadata.signal + top-level type) renders one notice', () => {
    // Verbatim shape of an accepted signal row read back from PostgresStore in the TN cells
    // (tnFreshMessages probe, 25 Nov): the human line is the TEXT part; attributes/stage live on
    // content.metadata.signal; the row carries top-level type 'task-progress'.
    const row = {
      id: 'sig-eb21d4c6',
      role: 'signal',
      content: {
        format: 2,
        parts: [{ type: 'text', text: 'Background task done: "Ship the runbook".', createdAt: 1795617080022 }],
        metadata: {
          signal: {
            id: 'sig-eb21d4c6',
            type: 'reactive',
            tagName: 'task-progress',
            createdAt: '2026-11-25T14:31:20.021Z',
            acceptedAt: '2026-11-25T14:31:19.988Z',
            attributes: { taskId: 'task-1', runId: 'run-1', stage: 'done', status: 'succeeded' },
          },
        },
      },
      createdAt: '2026-11-25T14:31:20.021Z',
      threadId: 't1',
      resourceId: 'company-1:chat:free',
      type: 'task-progress',
    };
    const items = chatItemsFromStoredMessages([row as unknown as StoredThreadMessage]);
    const n = notices(items);
    assert.equal(n.length, 1);
    assert.equal(n[0]!.stage, 'done');
    assert.equal(n[0]!.taskId, 'task-1');
    assert.match(n[0]!.text, /Background task done: "Ship the runbook"\./, 'the text part is the visible notice');
  });
});
