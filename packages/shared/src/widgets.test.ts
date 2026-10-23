/** WID-1: widget call parsing, answer schema/tool result/span event, and display redaction. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  WIDGET_MAX_ANSWER_BYTES,
  WIDGET_MAX_ARGS_BYTES,
  acceptWidgetAnswer,
  createWidgetSpecIndex,
  parseStoredWidgetAnswer,
  widgetDismissedToolResult,
  widgetFrontendTool,
  widgetJsonBytes,
  widgetResumeSchema,
  widgetSchemaProblems,
  widgetSpecProblems,
  widgetToolCallSchema,
  type WidgetSpec,
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

  it('masks token-style keys (token, accessToken, refresh_token, x-auth-token)', () => {
    const out = redactWidgetValue({ token: 't1', accessToken: 't2', refresh_token: 't3', 'x-auth-token': 't4', tokenizer: 'kept?' }) as Record<string, unknown>;
    assert.equal(out.token, '[redacted]');
    assert.equal(out.accessToken, '[redacted]');
    assert.equal(out.refresh_token, '[redacted]');
    assert.equal(out['x-auth-token'], '[redacted]');
    assert.doesNotMatch(JSON.stringify(out), /"t[1-4]"/);
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

describe('WID-1 size caps and strict envelopes (S2)', () => {
  it('args over the cap are invalid_args, as an object or as a string', () => {
    const big = 'x'.repeat(WIDGET_MAX_ARGS_BYTES);
    const r1 = parseWidgetToolCall({ toolCallId: 'c', toolName: 'askQuestion', args: { q: big } });
    assert.ok(!r1.ok && r1.reason === 'invalid_args');
    const r2 = parseWidgetToolCall({ toolCallId: 'c', toolName: 'askQuestion', args: JSON.stringify({ q: big }) });
    assert.ok(!r2.ok && r2.reason === 'invalid_args');
    const okArgs = parseWidgetToolCall({ toolCallId: 'c', toolName: 'askQuestion', args: { q: 'x'.repeat(WIDGET_MAX_ARGS_BYTES - 20) } });
    assert.ok(okArgs.ok);
  });

  it('byte length counts UTF-8, and unserializable values are infinitely large', () => {
    assert.equal(widgetJsonBytes('é'), 2);
    assert.equal(widgetJsonBytes({ a: 1 }), 7);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    assert.equal(widgetJsonBytes(cyclic), Number.POSITIVE_INFINITY);
  });

  it('call and answer envelopes refuse unknown fields; answers over the cap are refused', () => {
    assert.ok(!widgetToolCallSchema.safeParse({ toolCallId: 'c', toolName: 'a', args: {}, html: '<b>' }).success);
    const r = parseWidgetToolCall({ toolCallId: 'c', toolName: 'askQuestion', args: {}, extra: 1 });
    assert.ok(!r.ok && r.reason === 'invalid_call');
    const answer = { toolCallId: 'c1', widget: 'askQuestion', version: 1, answer: 'a', answeredAt: '2026-10-23T15:00:00.000Z' };
    assert.ok(widgetAnswerSchema.safeParse(answer).success);
    assert.ok(!widgetAnswerSchema.safeParse({ ...answer, approved: true }).success);
    assert.ok(!widgetAnswerSchema.safeParse({ ...answer, answer: 'x'.repeat(WIDGET_MAX_ANSWER_BYTES + 1) }).success);
  });
});

const spec: WidgetSpec = {
  name: 'pickOne',
  version: 2,
  description: 'Pick one.',
  propsSchema: z.strictObject({ question: z.string(), options: z.array(z.string()).min(2) }),
  answerSchema: z.strictObject({ choice: z.string() }),
  frontendTool: true,
};

describe('WID-1 widget specs (S3 strict rule)', () => {
  it('strict schemas comply; loose objects are reported with their path', () => {
    assert.deepEqual(widgetSchemaProblems(spec.propsSchema, { mustBeObject: true }), []);
    assert.deepEqual(widgetSchemaProblems(z.object({ a: z.string() })), ['(root): object must be strict (z.strictObject)']);
    assert.deepEqual(widgetSchemaProblems(z.strictObject({ a: z.strictObject({ b: z.looseObject({ c: z.string() }) }) })), [
      'a.b: object must be strict (z.strictObject)',
    ]);
    assert.deepEqual(widgetSchemaProblems(z.union([z.string(), z.object({ a: z.string() })])).length, 1);
    assert.deepEqual(widgetSchemaProblems(z.string(), { mustBeObject: true }), ['(root): must be a z.strictObject']);
    assert.deepEqual(widgetSchemaProblems(z.record(z.string(), z.number())), []);
  });

  it('schemas that accept any value are refused at any depth (unknown, any, custom, records / arrays of those)', () => {
    const untyped = 'value must have a described type (not unknown / any / custom)';
    assert.deepEqual(widgetSchemaProblems(z.unknown()), [`(root): ${untyped}`]);
    assert.deepEqual(widgetSchemaProblems(z.any()), [`(root): ${untyped}`]);
    assert.deepEqual(widgetSchemaProblems(z.custom<string>((v) => typeof v === 'string')), [`(root): ${untyped}`]);
    assert.deepEqual(widgetSchemaProblems(z.record(z.string(), z.unknown())), [`{}: ${untyped}`]);
    assert.deepEqual(widgetSchemaProblems(z.array(z.unknown())), [`[]: ${untyped}`]);
    assert.deepEqual(widgetSchemaProblems(z.strictObject({ a: z.strictObject({ b: z.any() }) })), [`a.b: ${untyped}`]);
    assert.deepEqual(widgetSchemaProblems(z.strictObject({ a: z.array(z.strictObject({ b: z.unknown() })) })), [`a[].b: ${untyped}`]);
    assert.deepEqual(widgetSchemaProblems(z.union([z.string(), z.unknown()])), [`(root): ${untyped}`]);
    // Typed values of every common kind comply.
    assert.deepEqual(
      widgetSchemaProblems(
        z.strictObject({
          s: z.string(),
          n: z.number().optional(),
          t: z.tuple([z.string(), z.number()]),
          r: z.record(z.string(), z.string()),
          e: z.enum(['a', 'b']),
          l: z.literal('x'),
          u: z.union([z.string(), z.number()]),
          nul: z.string().nullable(),
          d: z.boolean().default(false),
        }),
      ),
      [],
    );
    assert.match(widgetSpecProblems({ ...spec, answerSchema: z.strictObject({ value: z.unknown() }) }).join(), /answer value: value must have a described type/);
    assert.throws(() => createWidgetSpecIndex([{ ...spec, answerSchema: z.any() }]), /described type/);
  });

  it('json, lazy / recursive, preprocess and promise schemas are refused at any depth', () => {
    const has = (schema: z.ZodType, re: RegExp) => assert.match(widgetSchemaProblems(schema).join('\n'), re);
    has(z.json(), /lazy or recursive/);
    has(z.strictObject({ data: z.json() }), /lazy or recursive/);
    has(z.lazy(() => z.string()), /lazy or recursive/);
    has(z.preprocess((v) => v, z.string()), /z\.preprocess/);
    has(z.strictObject({ a: z.array(z.preprocess((v) => v, z.string())) }), /z\.preprocess/);
    has(z.promise(z.string()), /z\.promise/);
    has(z.strictObject({ p: z.promise(z.string()).optional() }), /z\.promise/);
    // Plain pipes and output transforms keep their described input type.
    assert.deepEqual(widgetSchemaProblems(z.string().pipe(z.string().min(1))), []);
    assert.throws(() => createWidgetSpecIndex([{ ...spec, answerSchema: z.strictObject({ data: z.json() }) }]), /lazy or recursive/);
  });

  it('getter recursion ($ref) is refused at any depth; reused and .meta({ id }) schemas are not', () => {
    const recursive: z.ZodType = z.strictObject({
      name: z.string(),
      get children() {
        return z.array(recursive);
      },
    });
    assert.match(widgetSchemaProblems(recursive).join('\n'), /recursive schemas \(\$ref\)/);
    assert.match(widgetSchemaProblems(z.strictObject({ tree: recursive })).join('\n'), /recursive schemas \(\$ref\)/);
    assert.throws(() => createWidgetSpecIndex([{ ...spec, answerSchema: recursive }]), /recursive schemas/);
    const named = z.strictObject({ a: z.string() }).meta({ id: 'widgetTestNamedPart', description: 'named part' });
    assert.deepEqual(widgetSchemaProblems(z.strictObject({ x: named, y: named })), []);
    const shared = z.strictObject({ a: z.string() });
    assert.deepEqual(widgetSchemaProblems(z.strictObject({ x: shared, y: z.array(shared) })), []);
  });

  it('output-side steps (transform, pipe, codec, overwrite) pass and the run gets the parsed output', () => {
    const ok = (schema: z.ZodType) => assert.deepEqual(widgetSchemaProblems(schema), []);
    ok(z.string().transform((v) => v.length));
    ok(z.string().pipe(z.string().min(1)));
    ok(z.codec(z.string(), z.number(), { decode: (v) => Number(v), encode: (v) => String(v) }));
    ok(z.string().overwrite((v) => v.trim()));
    const trimmed = { ...spec, answerSchema: z.strictObject({ choice: z.string().overwrite((v) => v.trim()) }) };
    const result = acceptWidgetAnswer(trimmed, 'tc-t', { choice: '  yes ' });
    assert.ok(result.ok);
    assert.deepEqual(result.ok && result.record.answer, { choice: 'yes' });
  });

  it('spec problems cover name, version range, props, answers and the reserved key', () => {
    assert.deepEqual(widgetSpecProblems(spec), []);
    assert.match(widgetSpecProblems({ ...spec, name: 'Bad-Name' })[0], /Invalid widget name/);
    assert.match(widgetSpecProblems({ ...spec, version: 1001 })[0], /Invalid version/);
    assert.match(widgetSpecProblems({ ...spec, answerSchema: z.object({ choice: z.string() }) })[0], /answer \(root\): object must be strict/);
    assert.match(widgetSpecProblems({ ...spec, propsSchema: z.strictObject({ widgetVersion: z.number() }) }).join(), /reserved key/);
  });

  it('spec index: lookups, latest frontend specs, duplicates and invalid specs refused', () => {
    const v1 = { ...spec, version: 1 };
    const note: WidgetSpec = { name: 'note', version: 1, description: 'Note.', propsSchema: z.strictObject({ text: z.string() }) };
    const index = createWidgetSpecIndex([spec, note, v1]);
    assert.equal(index.get('pickOne', 1), v1);
    assert.equal(index.latest('pickOne'), spec);
    assert.ok(index.has('note') && !index.has('nope'));
    assert.deepEqual(index.frontendSpecs(), [spec]);
    assert.throws(() => createWidgetSpecIndex([spec, { ...spec }]), /Duplicate widget/);
    assert.throws(() => createWidgetSpecIndex([{ ...spec, propsSchema: z.object({ q: z.string() }) }]), /must be strict/);
  });

  it('frontend tool: server spec parameters plus the offered widgetVersion', () => {
    const tool = widgetFrontendTool(spec);
    assert.equal(tool.name, 'pickOne');
    assert.equal(tool.parameters.additionalProperties, false);
    assert.deepEqual((tool.parameters.properties as Record<string, unknown>).widgetVersion, { type: 'integer', const: 2 });
    assert.equal(tool.parameters.$schema, undefined);
  });
});

describe('WID-1 accepting and storing answers', () => {
  const at = new Date('2026-10-23T15:00:00.000Z');

  it('valid answers become a record and the tool result', () => {
    assert.deepEqual(acceptWidgetAnswer(spec, 'c1', { choice: 'a' }, at), {
      ok: true,
      record: { toolCallId: 'c1', widget: 'pickOne', version: 2, answer: { choice: 'a' }, answeredAt: at.toISOString() },
      toolResult: JSON.stringify({ widget: 'pickOne', version: 2, answer: { choice: 'a' } }),
    });
  });

  it('unknown fields, wrong types, oversize answers and display-only widgets are refused without values', () => {
    const r = (answer: unknown, s: WidgetSpec = spec) => {
      const res = acceptWidgetAnswer(s, 'c1', answer, at);
      return res.ok ? 'ok' : res.issues;
    };
    assert.deepEqual(r({ choice: 'a', extra: 'secret-1' }), ['(root): unrecognized_keys']);
    assert.deepEqual(r({ choice: 1 }), ['choice: invalid_type']);
    assert.deepEqual(r({ choice: 'x'.repeat(WIDGET_MAX_ANSWER_BYTES) }), ['(root): too_big']);
    assert.deepEqual(r({ choice: 'a' }, { ...spec, answerSchema: undefined }), ['(root): widget does not take answers']);
    assert.doesNotMatch(JSON.stringify(r({ choice: 'a', extra: 'secret-1' })), /secret-1/);
  });

  it('resume data is strict and either an answer record or a dismissal', () => {
    const ok = acceptWidgetAnswer(spec, 'c1', { choice: 'a' }, at);
    assert.ok(ok.ok);
    assert.ok(widgetResumeSchema.safeParse({ kind: 'answer', record: ok.record }).success);
    assert.ok(widgetResumeSchema.safeParse({ kind: 'dismissed', toolCallId: 'c1' }).success);
    assert.ok(!widgetResumeSchema.safeParse({ kind: 'answer', record: ok.record, extra: 1 }).success);
    assert.ok(!widgetResumeSchema.safeParse({ kind: 'answer', record: { ...ok.record, extra: 1 } }).success);
    assert.ok(!widgetResumeSchema.safeParse({ kind: 'approve' }).success);
    assert.deepEqual(JSON.parse(widgetDismissedToolResult(spec)), { widget: 'pickOne', version: 2, dismissed: true });
  });

  it('stored answers are read back from tool results; dismissals, errors and other tools are not answers', () => {
    const result = JSON.stringify({ widget: 'pickOne', version: 2, answer: { choice: 'a' } });
    assert.deepEqual(parseStoredWidgetAnswer('c1', 'pickOne', result), { toolCallId: 'c1', widget: 'pickOne', version: 2, answer: { choice: 'a' } });
    assert.deepEqual(parseStoredWidgetAnswer('c1', 'pickOne', JSON.parse(result))?.answer, { choice: 'a' });
    assert.equal(parseStoredWidgetAnswer('c1', 'pickOne', widgetDismissedToolResult(spec)), null);
    assert.equal(parseStoredWidgetAnswer('c1', 'other', result), null);
    assert.equal(parseStoredWidgetAnswer('c1', 'pickOne', { isError: true, content: 'x' }), null);
    assert.equal(parseStoredWidgetAnswer('c1', 'pickOne', '{bad'), null);
  });
});
