/**
 * AGUI-1: AgentController session events → AG-UI events (pure mapper).
 * The first fixture is the sequence a real session emits for "one tool call, then text" (recorded from
 * the stub-model run in session-stream.test.ts; tool input events arrive before the assistant message).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventSchemas } from '@ag-ui/core/schemas';
import { AGUI_CUSTOM, createAguiEventMapper, type AguiSourceEvent } from './session-events';

const T = 'thread-1';
const run = (events: AguiSourceEvent[], finish?: Parameters<ReturnType<typeof createAguiEventMapper>['finish']>[0]) => {
  const mapper = createAguiEventMapper({ threadId: T, runId: 'run-1', mastraThreadId: T });
  const out = events.flatMap((e) => mapper.map(e));
  out.push(...mapper.finish(finish));
  for (const e of out) EventSchemas.parse(e); // every event is a valid AG-UI event
  return out as Array<Record<string, unknown>>;
};
const types = (events: Array<Record<string, unknown>>) => events.map((e) => e.type);

const toolThenText: AguiSourceEvent[] = [
  { type: 'agent_start' },
  { type: 'message_start', message: { id: 'u1', role: 'signal' } },
  { type: 'message_end', id: 'u1' },
  { type: 'tool_input_start', threadId: T, toolCallId: 'call-1', toolName: 'echo', messageId: 'm1' },
  { type: 'tool_input_delta', threadId: T, toolCallId: 'call-1', argsTextDelta: '{"text":"hi"}', toolName: 'echo', messageId: 'm1' },
  { type: 'tool_input_end', threadId: T, toolCallId: 'call-1', messageId: 'm1' },
  { type: 'message_start', message: { id: 'm1', role: 'assistant' } },
  { type: 'tool_start', threadId: T, toolCallId: 'call-1', toolName: 'echo', args: { text: 'hi' } },
  { type: 'message_update', id: 'm1', event: { type: 'part', index: 0, part: { type: 'tool-invocation' } } },
  { type: 'tool_end', threadId: T, toolCallId: 'call-1', result: { echoed: 'hi' }, isError: false },
  { type: 'usage_update', usage: {} },
  { type: 'message_update', id: 'm1', event: { type: 'part', index: 1, part: { type: 'text', text: '' } } },
  { type: 'message_update', id: 'm1', event: { type: 'text-delta', delta: 'Hello ' } },
  { type: 'message_update', id: 'm1', event: { type: 'text-delta', delta: 'there' } },
  { type: 'message_end', id: 'm1' },
  { type: 'agent_end', reason: 'complete' },
];

describe('AGUI-1 session event mapper', () => {
  it('maps one tool call then text to the AG-UI sequence', () => {
    const out = run(toolThenText);
    assert.deepEqual(types(out), [
      'TOOL_CALL_START',
      'TOOL_CALL_ARGS',
      'TOOL_CALL_END',
      'TOOL_CALL_RESULT',
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END',
      'RUN_FINISHED',
    ]);
    assert.deepEqual(out[0], { type: 'TOOL_CALL_START', toolCallId: 'call-1', toolCallName: 'echo', parentMessageId: 'm1' });
    assert.equal(out[1].delta, '{"text":"hi"}');
    assert.equal(out[3].content, '{"echoed":"hi"}');
    assert.equal(out[4].messageId, 'm1');
    assert.equal(out[4].role, 'assistant');
    assert.deepEqual(out[8].outcome, { type: 'success' });
    assert.equal(out[8].threadId, T);
    assert.equal(out[8].runId, 'run-1');
  });

  it('splits text around a tool call into separate text messages', () => {
    const out = run([
      { type: 'agent_start' },
      { type: 'message_start', message: { id: 'm1', role: 'assistant' } },
      { type: 'message_update', id: 'm1', event: { type: 'text-delta', delta: 'Let me check. ' } },
      { type: 'tool_input_start', toolCallId: 'c1', toolName: 'lookup', messageId: 'm1' },
      { type: 'tool_input_end', toolCallId: 'c1', messageId: 'm1' },
      { type: 'tool_end', toolCallId: 'c1', result: 'ok', isError: false },
      { type: 'message_update', id: 'm1', event: { type: 'text-delta', delta: 'Done.' } },
      { type: 'message_end', id: 'm1' },
      { type: 'agent_end', reason: 'complete' },
    ]);
    assert.deepEqual(types(out), [
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END',
      'TOOL_CALL_START',
      'TOOL_CALL_END',
      'TOOL_CALL_RESULT',
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END',
      'RUN_FINISHED',
    ]);
    assert.equal(out[0].messageId, 'm1');
    assert.equal(out[6].messageId, 'm1:text:1');
  });

  it('synthesises start/args/end when only tool_start is seen, keeping the tool id', () => {
    const out = run([
      { type: 'agent_start' },
      { type: 'tool_start', toolCallId: 'c9', toolName: 'tourbillon_issues', args: { q: 1 } },
      { type: 'tool_end', toolCallId: 'c9', result: new Error('nope'), isError: true },
      { type: 'agent_end', reason: 'complete' },
    ]);
    assert.deepEqual(types(out), ['TOOL_CALL_START', 'TOOL_CALL_ARGS', 'TOOL_CALL_END', 'TOOL_CALL_RESULT', 'RUN_FINISHED']);
    assert.equal(out[0].toolCallName, 'tourbillon_issues');
    assert.equal(out[1].delta, '{"q":1}');
    assert.deepEqual(JSON.parse(out[3].content as string), { error: { name: 'Error', message: 'nope' } });
    assert.deepEqual(out[3].metadata, { isError: true, denied: false });
  });

  it('maps reasoning deltas to a reasoning message', () => {
    const out = run([
      { type: 'agent_start' },
      { type: 'message_start', message: { id: 'm1', role: 'assistant' } },
      { type: 'message_update', id: 'm1', event: { type: 'reasoning-delta', index: 0, delta: 'thinking' } },
      { type: 'message_update', id: 'm1', event: { type: 'text-delta', delta: 'Answer' } },
      { type: 'message_end', id: 'm1' },
      { type: 'agent_end', reason: 'complete' },
    ]);
    assert.deepEqual(types(out), [
      'REASONING_START',
      'REASONING_MESSAGE_START',
      'REASONING_MESSAGE_CONTENT',
      'REASONING_MESSAGE_END',
      'REASONING_END',
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END',
      'RUN_FINISHED',
    ]);
  });

  it('aborted run finishes as cancelled and closes the open text message', () => {
    const out = run([
      { type: 'agent_start' },
      { type: 'message_start', message: { id: 'm1', role: 'assistant' } },
      { type: 'message_update', id: 'm1', event: { type: 'text-delta', delta: 'partial' } },
      { type: 'agent_end', reason: 'aborted' },
    ]);
    assert.deepEqual(types(out), ['TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END', 'RUN_FINISHED']);
    assert.deepEqual(out[3].outcome, { type: 'cancelled' });
  });

  it('error run ends with RUN_ERROR carrying the error message', () => {
    const out = run([
      { type: 'agent_start' },
      { type: 'error', error: new Error('model unavailable') },
      { type: 'agent_end', reason: 'error' },
    ]);
    assert.deepEqual(types(out), ['RUN_ERROR']);
    assert.equal(out[0].message, 'model unavailable');
  });

  it('a pending tool approval is surfaced as CUSTOM and as an interrupt outcome', () => {
    const out = run([
      { type: 'agent_start' },
      { type: 'tool_approval_required', toolCallId: 'c2', toolName: 'delete_thing', args: { id: 'x' } },
      { type: 'agent_end', reason: 'suspended' },
    ]);
    assert.deepEqual(types(out), ['TOOL_CALL_START', 'TOOL_CALL_ARGS', 'TOOL_CALL_END', 'CUSTOM', 'RUN_FINISHED']);
    assert.equal(out[3].name, AGUI_CUSTOM.toolApprovalRequired);
    assert.deepEqual(out[3].value, { toolCallId: 'c2', toolName: 'delete_thing', args: { id: 'x' } });
    assert.deepEqual(out[4].outcome, {
      type: 'interrupt',
      interrupts: [{ id: 'c2', reason: 'tool_approval', toolCallId: 'c2' }],
    });
  });

  it('ignores tool events from another Mastra thread and non-assistant messages', () => {
    const out = run([
      { type: 'agent_start' },
      { type: 'tool_start', threadId: 'other-thread', toolCallId: 'x', toolName: 'echo', args: {} },
      { type: 'message_start', message: { id: 'u', role: 'user' } },
      { type: 'message_update', id: 'u', event: { type: 'text-delta', delta: 'user text' } },
      { type: 'agent_end', reason: 'complete' },
    ]);
    assert.deepEqual(types(out), ['RUN_FINISHED']);
  });

  it('finish() is one-shot and later events are dropped', () => {
    const mapper = createAguiEventMapper({ threadId: T, runId: 'r' });
    assert.equal(mapper.finish().length, 1);
    assert.deepEqual(mapper.finish(), []);
    assert.deepEqual(mapper.map({ type: 'tool_start', toolCallId: 'a', toolName: 'b' }), []);
  });
});
