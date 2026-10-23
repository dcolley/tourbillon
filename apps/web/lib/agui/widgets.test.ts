/** WID-1: which widgets a run offers, resume entries → validated answers, stored answers read back. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { createWidgetSpecIndex, type WidgetSpec } from '@tourbillon/shared/widgets';
import { selectWidgetSpecs, suspendedWidgetSpec, widgetAnswersFromMessages, widgetResumeFromEntry } from './widgets';

const picker: WidgetSpec = {
  name: 'testPicker',
  version: 2,
  description: 'Pick.',
  propsSchema: z.strictObject({ question: z.string() }),
  answerSchema: z.strictObject({ choice: z.string() }),
  frontendTool: true,
};
const pickerV1 = { ...picker, version: 1 };
const display: WidgetSpec = { name: 'note', version: 1, description: 'Note.', propsSchema: z.strictObject({ text: z.string() }) };
const index = createWidgetSpecIndex([pickerV1, picker, display]);
const at = new Date('2026-10-23T15:00:00.000Z');

describe('WID-1 selectWidgetSpecs', () => {
  it('offers declared AND known frontend widgets (latest version), once each', () => {
    const out = selectWidgetSpecs(index, [
      { name: 'testPicker' },
      { name: 'testPicker' },
      { name: 'note' },
      { name: 'unknown' },
      { name: 42 },
      {},
    ]);
    assert.deepEqual(out, [picker]);
    assert.deepEqual(selectWidgetSpecs(index, undefined), []);
    assert.deepEqual(selectWidgetSpecs(index, []), []);
  });

  it('looks at a bounded number of declared tools', () => {
    const many = [...Array.from({ length: 200 }, (_, i) => ({ name: `t${i}` })), { name: 'testPicker' }];
    assert.deepEqual(selectWidgetSpecs(index, many), []);
  });
});

describe('WID-1 suspendedWidgetSpec', () => {
  const session = (toolName?: string) => ({
    suspensions: { get: ({ toolCallId }: { toolCallId: string }) => (toolName && toolCallId === 'c1' ? { toolName } : undefined) },
  });
  it('maps a parked widget call to its spec; other tools and unknown calls are not widgets', () => {
    assert.equal(suspendedWidgetSpec(index, session('testPicker'), 'c1'), picker);
    assert.equal(suspendedWidgetSpec(index, session('testPicker'), 'c2'), undefined);
    assert.equal(suspendedWidgetSpec(index, session('ask_user'), 'c1'), undefined);
    assert.equal(suspendedWidgetSpec(index, session('note'), 'c1'), undefined);
    assert.equal(suspendedWidgetSpec(index, {}, 'c1'), undefined);
  });
});

describe('WID-1 widgetResumeFromEntry', () => {
  it('a resolved entry with { answer } becomes an answer record', () => {
    assert.deepEqual(widgetResumeFromEntry(picker, { toolCallId: 'c1', status: 'resolved', payload: { answer: { choice: 'a' } } }, at), {
      ok: true,
      resume: {
        kind: 'answer',
        record: { toolCallId: 'c1', widget: 'testPicker', version: 2, answer: { choice: 'a' }, answeredAt: at.toISOString() },
      },
    });
  });

  it('a cancelled entry without payload is a dismissal', () => {
    assert.deepEqual(widgetResumeFromEntry(picker, { toolCallId: 'c1', status: 'cancelled' }), {
      ok: true,
      resume: { kind: 'dismissed', toolCallId: 'c1' },
    });
  });

  it('refuses bad payloads and answers, naming the problem but never echoing values', () => {
    const issues = (entry: { status: string; payload?: unknown }) => {
      const r = widgetResumeFromEntry(picker, { toolCallId: 'c1', ...entry }, at);
      return r.ok ? 'ok' : r.issues;
    };
    assert.deepEqual(issues({ status: 'resolved' }), ['payload: must be { answer } with no other fields']);
    assert.deepEqual(issues({ status: 'resolved', payload: {} }), ['payload: must be { answer } with no other fields']);
    assert.deepEqual(issues({ status: 'resolved', payload: { answer: { choice: 'a' }, approved: true } }), [
      'payload: must be { answer } with no other fields',
    ]);
    assert.deepEqual(issues({ status: 'resolved', payload: { answer: { choice: 'a', secret: 'v-123' } } }), [
      'answer.(root): unrecognized_keys',
    ]);
    assert.deepEqual(issues({ status: 'resolved', payload: { answer: { choice: 'x'.repeat(17000) } } }), ['answer.(root): too_big']);
    assert.deepEqual(issues({ status: 'cancelled', payload: { answer: 1 } }), ['payload: a dismissal carries no payload']);
    assert.deepEqual(issues({ status: 'other' }), ['status: unsupported']);
    assert.doesNotMatch(JSON.stringify(issues({ status: 'resolved', payload: { answer: { choice: 'a', secret: 'v-123' } } })), /v-123/);
  });
});

describe('WID-1 widgetAnswersFromMessages', () => {
  const inv = (toolCallId: string, toolName: string, result: unknown, state = 'result') => ({
    type: 'tool-invocation',
    toolInvocation: { toolCallId, toolName, state, args: {}, result },
  });
  it('reads widget answers from stored tool results; skips dismissals, errors, pending calls and other tools', () => {
    const answer = JSON.stringify({ widget: 'testPicker', version: 2, answer: { choice: 'a' } });
    const messages = [
      { createdAt: new Date('2026-10-23T15:00:00.000Z'), content: { parts: [{ type: 'text', text: 'hi' }, inv('c1', 'testPicker', answer)] } },
      { createdAt: '2026-10-23T15:01:00.000Z', content: { parts: [inv('c2', 'testPicker', JSON.stringify({ widget: 'testPicker', version: 2, dismissed: true }))] } },
      { content: { parts: [inv('c3', 'testPicker', { isError: true, content: 'x' })] } },
      { content: { parts: [inv('c4', 'testPicker', undefined, 'call')] } },
      { content: { parts: [inv('c5', 'echo', answer)] } },
      { content: { parts: [inv('c6', 'unknownWidget', answer)] } },
      { content: 'plain string' },
    ];
    assert.deepEqual(widgetAnswersFromMessages(index, messages), [
      { toolCallId: 'c1', widget: 'testPicker', version: 2, answer: { choice: 'a' }, answeredAt: '2026-10-23T15:00:00.000Z' },
    ]);
  });
});
