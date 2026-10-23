/** WID-1: widget call parsing, answer schema/tool result/span event, and display redaction. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseWidgetToolCall,
  redactWidgetValue,
  widgetAnswerSchema,
  widgetAnswerSpanEvent,
  widgetAnswerToolResult,
  WIDGET_FALLBACK_MESSAGES,
} from './widgets';

describe('WID-1 parseWidgetToolCall', () => {
  it('object or JSON-string args; version defaults to 1 and is stripped from props', () => {
    assert.deepEqual(parseWidgetToolCall({ toolCallId: 'c1', toolName: 'askQuestion', args: { q: 'Why?' } }), {
      ok: true,
      call: { toolCallId: 'c1', name: 'askQuestion', version: 1, props: { q: 'Why?' } },
    });
    assert.deepEqual(
      parseWidgetToolCall({ toolCallId: 'c2', toolName: 'askQuestion', args: '{"q":"Why?","widgetVersion":2}' }),
      { ok: true, call: { toolCallId: 'c2', name: 'askQuestion', version: 2, props: { q: 'Why?' } } },
    );
    const empty = parseWidgetToolCall({ toolCallId: 'c3', toolName: 'confirm', args: '' });
    assert.ok(empty.ok && Object.keys(empty.call.props).length === 0);
  });

  it('reports why a call is unusable, keeping ids for the fallback card', () => {
    const r = (input: unknown) => {
      const res = parseWidgetToolCall(input);
      return res.ok ? 'ok' : [res.reason, res.toolCallId, res.toolName];
    };
    assert.deepEqual(r(null), ['invalid_call', undefined, undefined]);
    assert.deepEqual(r({ toolCallId: 'c', toolName: 'x' }), ['invalid_call', 'c', 'x']);
    assert.deepEqual(r({ toolCallId: 'c', toolName: 'askQuestion', args: '{bad' }), ['invalid_args', 'c', 'askQuestion']);
    assert.deepEqual(r({ toolCallId: 'c', toolName: 'askQuestion', args: '[1]' }), ['invalid_args', 'c', 'askQuestion']);
    assert.deepEqual(r({ toolCallId: 'c', toolName: 'web_search', args: {} }), ['invalid_name', 'c', 'web_search']);
    assert.deepEqual(r({ toolCallId: 'c', toolName: 'askQuestion', args: { widgetVersion: 0 } }), [
      'invalid_version',
      'c',
      'askQuestion',
    ]);
    assert.deepEqual(r({ toolCallId: 'c', toolName: 'askQuestion', args: { widgetVersion: '2' } }), [
      'invalid_version',
      'c',
      'askQuestion',
    ]);
  });

  it('every fallback reason has a user-facing message', () => {
    for (const reason of ['invalid_call', 'invalid_args', 'invalid_name', 'invalid_version', 'unknown_widget', 'unknown_version', 'invalid_props'] as const) {
      assert.ok(WIDGET_FALLBACK_MESSAGES[reason].length > 0, reason);
    }
  });
});

describe('WID-1 widget answers', () => {
  const answer = {
    toolCallId: 'c1',
    widget: 'askQuestion',
    version: 1,
    answer: { choice: 'b', note: 'private text' },
    answeredAt: '2026-10-23T15:00:00.000Z',
  };

  it('schema accepts a well-formed answer and refuses bad names, versions and times', () => {
    assert.ok(widgetAnswerSchema.safeParse(answer).success);
    assert.ok(!widgetAnswerSchema.safeParse({ ...answer, widget: 'Bad-Name' }).success);
    assert.ok(!widgetAnswerSchema.safeParse({ ...answer, version: 1.5 }).success);
    assert.ok(!widgetAnswerSchema.safeParse({ ...answer, answeredAt: 'yesterday' }).success);
  });

  it('tool result carries widget, version and answer', () => {
    assert.deepEqual(JSON.parse(widgetAnswerToolResult(answer)), {
      widget: 'askQuestion',
      version: 1,
      answer: { choice: 'b', note: 'private text' },
    });
  });

  it('span event carries ids and answer shape, never answer values', () => {
    const ev = widgetAnswerSpanEvent(answer);
    assert.equal(ev.name, 'tourbillon.widget.answer');
    assert.deepEqual(ev.attributes, {
      'widget.name': 'askQuestion',
      'widget.version': 1,
      'widget.tool_call_id': 'c1',
      'widget.answer.kind': 'object',
      'widget.answer.fields': 2,
    });
    assert.doesNotMatch(JSON.stringify(ev), /private text/);
    assert.equal(widgetAnswerSpanEvent({ ...answer, answer: [1, 2, 3] }).attributes['widget.answer.items'], 3);
    assert.equal(widgetAnswerSpanEvent({ ...answer, answer: true }).attributes['widget.answer.kind'], 'boolean');
  });
});

describe('WID-1 redactWidgetValue', () => {
  it('masks sensitive keys at any depth without mutating the input', () => {
    const input = { query: 'x', apiKey: 'k1', nested: { Authorization: 'Bearer t', list: [{ password: 'p', ok: 1 }] } };
    const out = redactWidgetValue(input) as Record<string, any>;
    assert.equal(out.query, 'x');
    assert.equal(out.apiKey, '[redacted]');
    assert.equal(out.nested.Authorization, '[redacted]');
    assert.deepEqual(out.nested.list, [{ password: '[redacted]', ok: 1 }]);
    assert.equal(input.apiKey, 'k1');
  });

  it('cuts cycles and deep nesting', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    assert.deepEqual(redactWidgetValue(a), { name: 'a', self: '[…]' });
    let deep: Record<string, unknown> = { v: 1 };
    for (let i = 0; i < 12; i++) deep = { d: deep };
    assert.match(JSON.stringify(redactWidgetValue(deep)), /\[…\]/);
  });
});
