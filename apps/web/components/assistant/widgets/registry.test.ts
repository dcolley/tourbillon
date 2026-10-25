/**
 * WID-1: widget registry — lookup by name + version, schema failures, fallback reasons and warnings,
 * frontend tool declarations, answer validation.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { createWidgetRegistry, assistantWidgetRegistry, WidgetRegistryError } from './registry';
import { assistantWidgetSpecs } from './specs';
import type { WidgetDefinition } from './widget-types';

const Noop = () => null;

const pickV1: WidgetDefinition = {
  name: 'pickOne',
  version: 1,
  description: 'Ask the user to pick one option.',
  propsSchema: z.strictObject({ question: z.string().min(1), options: z.array(z.string()).min(2) }),
  answerSchema: z.strictObject({ choice: z.string() }),
  component: Noop,
  frontendTool: true,
};
const pickV2: WidgetDefinition = {
  ...pickV1,
  version: 2,
  propsSchema: z.strictObject({ question: z.string().min(1), options: z.array(z.string()).min(2), multiple: z.boolean().default(false) }),
  answerSchema: z.strictObject({ choices: z.array(z.string()).min(1) }),
};
const status: WidgetDefinition = {
  name: 'statusNote',
  version: 1,
  description: 'Display-only note.',
  propsSchema: z.strictObject({ text: z.string() }),
  component: Noop,
};

function registry() {
  const warnings: Array<{ message: string; details: Record<string, unknown> }> = [];
  const reg = createWidgetRegistry([pickV2, status, pickV1], { warn: (message, details) => warnings.push({ message, details }) });
  return { reg, warnings };
}

const call = (toolName: string, args: unknown, toolCallId = 'call-1') => ({ toolCallId, toolName, args });

describe('WID-1 registry lookup', () => {
  it('get / latest / list', () => {
    const { reg } = registry();
    assert.equal(reg.get('pickOne', 1), pickV1);
    assert.equal(reg.get('pickOne', 2), pickV2);
    assert.equal(reg.get('pickOne', 3), undefined);
    assert.equal(reg.latest('pickOne'), pickV2);
    assert.equal(reg.latest('nope'), undefined);
    assert.deepEqual(reg.list().map((d) => `${d.name}@${d.version}`), ['pickOne@1', 'pickOne@2', 'statusNote@1']);
  });

  it('refuses duplicate name+version, bad names and bad versions at registration', () => {
    assert.throws(() => createWidgetRegistry([pickV1, { ...pickV1 }]), WidgetRegistryError);
    assert.throws(() => createWidgetRegistry([{ ...pickV1, name: 'Pick-One' }]), /Invalid widget name/);
    assert.throws(() => createWidgetRegistry([{ ...pickV1, version: 0 }]), /Invalid version/);
    assert.throws(() => createWidgetRegistry([{ ...pickV1, version: 1.5 }]), /Invalid version/);
  });

  it('the assistant registry has the WID-2 approval card and the WID-3 chat cards; only the chat cards are frontend tools; other tools fall back', () => {
    assert.deepEqual(assistantWidgetRegistry.list().map((d) => `${d.name}@${d.version}`), [
      'approvalCard@1',
      'askChoice@1',
      'askConfirm@1',
      'askForm@1',
      'askQuestion@1',
    ]);
    assert.deepEqual(assistantWidgetRegistry.frontendTools().map((t) => t.name), ['askChoice', 'askConfirm', 'askForm', 'askQuestion']);
    const fallback = createWidgetRegistry(assistantWidgetRegistry.list(), { warn: () => {} }).resolve(call('web_search', { q: 'x' }));
    assert.equal(fallback.ok, false);
  });

  it('versions above the call-side cap (1000) are refused at registration, so every version can resolve', () => {
    assert.throws(() => createWidgetRegistry([{ ...pickV1, version: 1001 }]), /Invalid version/);
    const reg = createWidgetRegistry([{ ...pickV1, version: 1000 }], { warn: () => {} });
    assert.ok(reg.resolve(call('pickOne', { question: 'q', options: ['a', 'b'], widgetVersion: 1000 })).ok);
  });

  it('the client registry and the server specs list the same widgets (name, version, frontend tool)', () => {
    const key = (d: { name: string; version: number; frontendTool?: boolean }) => `${d.name}@${d.version}:${Boolean(d.frontendTool)}`;
    assert.deepEqual(assistantWidgetRegistry.list().map(key), [...assistantWidgetSpecs].map(key).sort());
  });
});

describe('WID-1 strict widget schemas (rule)', () => {
  it('props must be a z.strictObject; loose or non-object props are refused at registration', () => {
    assert.throws(() => createWidgetRegistry([{ ...pickV1, propsSchema: z.object({ q: z.string() }) }]), /props \(root\): object must be strict/);
    assert.throws(() => createWidgetRegistry([{ ...pickV1, propsSchema: z.looseObject({ q: z.string() }) }]), /must be strict/);
    assert.throws(() => createWidgetRegistry([{ ...pickV1, propsSchema: z.string() as never }]), /must be a z\.strictObject/);
  });

  it('nested objects in props and answers must be strict too; records are allowed', () => {
    assert.throws(
      () => createWidgetRegistry([{ ...pickV1, propsSchema: z.strictObject({ meta: z.object({ a: z.string() }) }) }]),
      /props meta: object must be strict/,
    );
    assert.throws(
      () => createWidgetRegistry([{ ...pickV1, answerSchema: z.object({ choice: z.string() }) }]),
      /answer \(root\): object must be strict/,
    );
    assert.throws(
      () => createWidgetRegistry([{ ...pickV1, answerSchema: z.strictObject({ rows: z.array(z.object({ a: z.number() })) }) }]),
      /answer rows\[?.*must be strict/,
    );
    const ok = createWidgetRegistry(
      [{ ...pickV1, propsSchema: z.strictObject({ labels: z.record(z.string(), z.string()) }), answerSchema: z.enum(['a', 'b']) }],
      { warn: () => {} },
    );
    assert.equal(ok.list().length, 1);
  });

  it('props may not use the reserved widgetVersion key', () => {
    assert.throws(
      () => createWidgetRegistry([{ ...pickV1, propsSchema: z.strictObject({ widgetVersion: z.number() }) }]),
      /reserved key widgetVersion/,
    );
  });

  it('strict props refuse unknown keys instead of stripping them', () => {
    const { reg } = registry();
    const r = reg.resolve(call('pickOne', { question: 'q', options: ['a', 'b'], injected: '<b>x</b>' }));
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.reason, 'invalid_props');
  });
});

describe('WID-1 registry resolve', () => {
  it('resolves by version (default 1) and returns schema-parsed props', () => {
    const { reg, warnings } = registry();
    const v1 = reg.resolve(call('pickOne', { question: 'Which?', options: ['a', 'b'] }));
    assert.ok(v1.ok);
    assert.equal(v1.definition, pickV1);
    const v2 = reg.resolve(call('pickOne', JSON.stringify({ question: 'Which?', options: ['a', 'b'], widgetVersion: 2 })));
    assert.ok(v2.ok);
    assert.equal(v2.definition, pickV2);
    assert.deepEqual(v2.call.props, { question: 'Which?', options: ['a', 'b'], multiple: false });
    assert.deepEqual(warnings, []);
  });

  it('unknown widget, unknown version, invalid props and bad calls give a reason and one warning each', () => {
    const { reg, warnings } = registry();
    const cases: Array<[unknown, string]> = [
      [call('noSuchWidget', {}), 'unknown_widget'],
      [call('pickOne', { question: 'q', options: ['a', 'b'], widgetVersion: 9 }), 'unknown_version'],
      [call('pickOne', { question: '', options: ['a'] }), 'invalid_props'],
      [call('pickOne', '{not json'), 'invalid_args'],
      [call('web_search', {}), 'invalid_name'],
      [{ toolName: 'pickOne' }, 'invalid_call'],
    ];
    for (const [input, reason] of cases) {
      const r = reg.resolve(input);
      assert.equal(r.ok, false);
      assert.equal(!r.ok && r.reason, reason);
    }
    assert.equal(warnings.length, cases.length);
    assert.deepEqual(warnings.map((w) => w.details.reason), cases.map(([, reason]) => reason));
  });

  it('invalid-props warnings name the failing paths but never log prop values', () => {
    const { reg, warnings } = registry();
    reg.resolve(call('pickOne', { question: 42, options: ['secret-value-xyz'] }, 'call-9'));
    assert.equal(warnings.length, 1);
    const { details } = warnings[0];
    assert.equal(details.toolCallId, 'call-9');
    assert.equal(details.toolName, 'pickOne');
    assert.deepEqual(details.issues, ['question: invalid_type', 'options: too_small']);
    assert.doesNotMatch(JSON.stringify(warnings), /secret-value-xyz/);
  });
});

describe('WID-1 frontend tools', () => {
  it('declares the latest version of each frontend-tool widget with JSON Schema parameters', () => {
    const { reg } = registry();
    const tools = reg.frontendTools();
    assert.deepEqual(tools.map((t) => t.name), ['pickOne']);
    const [tool] = tools;
    assert.equal(tool.description, pickV1.description);
    assert.equal(tool.parameters.type, 'object');
    assert.equal(tool.parameters.$schema, undefined);
    const props = tool.parameters.properties as Record<string, any>;
    assert.deepEqual(Object.keys(props).sort(), ['multiple', 'options', 'question', 'widgetVersion']);
    assert.deepEqual(props.widgetVersion, { type: 'integer', const: 2 });
    assert.deepEqual(tool.parameters.required, ['question', 'options']);
  });
});

describe('WID-1 answers', () => {
  it('valid answers become a stored record and a tool result; invalid ones list issues', () => {
    const { reg } = registry();
    const r = reg.resolve(call('pickOne', { question: 'q', options: ['a', 'b'] }, 'call-7'));
    assert.ok(r.ok);
    const ok = reg.acceptAnswer(r, { choice: 'b' }, new Date('2026-10-23T15:00:00.000Z'));
    assert.deepEqual(ok, {
      ok: true,
      record: { toolCallId: 'call-7', widget: 'pickOne', version: 1, answer: { choice: 'b' }, answeredAt: '2026-10-23T15:00:00.000Z' },
      toolResult: JSON.stringify({ widget: 'pickOne', version: 1, answer: { choice: 'b' } }),
    });
    assert.deepEqual(reg.acceptAnswer(r, { choice: 3 }), { ok: false, issues: ['choice: invalid_type'] });
  });

  it('answers with unknown fields or over the size cap are refused (paths only, no values)', () => {
    const { reg } = registry();
    const r = reg.resolve(call('pickOne', { question: 'q', options: ['a', 'b'] }, 'call-8'));
    assert.ok(r.ok);
    assert.deepEqual(reg.acceptAnswer(r, { choice: 'b', extra: 'secret-extra' }), { ok: false, issues: ['(root): unrecognized_keys'] });
    const big = reg.acceptAnswer(r, { choice: 'x'.repeat(17 * 1024) });
    assert.deepEqual(big, { ok: false, issues: ['(root): too_big'] });
  });

  it('display-only widgets take no answers', () => {
    const { reg } = registry();
    const r = reg.resolve(call('statusNote', { text: 'hi' }));
    assert.ok(r.ok);
    assert.equal(reg.acceptAnswer(r, 'x').ok, false);
  });
});
