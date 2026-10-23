/** WID-1: request-scoped widget tools that suspend for the client and return the user's answer. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { RequestContext } from '@mastra/core/request-context';
import { acceptWidgetAnswer, type WidgetSpec } from '@tourbillon/shared/widgets';
import {
  REQUEST_WIDGET_SPECS_KEY,
  createWidgetTool,
  requestScopedTools,
  setRequestWidgetSpecs,
} from './widget-tools';

const spec: WidgetSpec = {
  name: 'pickOne',
  version: 3,
  description: 'Ask the user to pick one option.',
  propsSchema: z.strictObject({ question: z.string(), options: z.array(z.string()).min(2) }),
  answerSchema: z.strictObject({ choice: z.string() }),
  frontendTool: true,
};
const ARGS = { question: 'Ship?', options: ['Yes', 'No'] };
const at = new Date('2026-10-23T15:00:00.000Z');

function record(toolCallId = 'c1', answer: unknown = { choice: 'Yes' }) {
  const r = acceptWidgetAnswer(spec, toolCallId, answer, at);
  assert.ok(r.ok);
  return r.record;
}

function context(agent: Record<string, unknown>) {
  const spans: Array<{ type: string; name: string; metadata?: Record<string, unknown> }> = [];
  const suspended: unknown[] = [];
  const ctx = {
    agent: {
      toolCallId: 'c1',
      suspend: async (payload: unknown) => {
        suspended.push(payload);
      },
      ...agent,
    },
    tracingContext: { currentSpan: { createEventSpan: (o: (typeof spans)[number]) => spans.push(o) } },
  };
  return { ctx, spans, suspended };
}

const exec = (input: unknown, ctx: unknown) =>
  (createWidgetTool(spec).execute as (i: unknown, c: unknown) => Promise<unknown>)(input, ctx);

describe('WID-1 request-scoped widget tools', () => {
  it('no widget specs in the request context → no tools (REST chat, heartbeats)', () => {
    assert.deepEqual(requestScopedTools({}), {});
    assert.deepEqual(requestScopedTools({ requestContext: new RequestContext() }), {});
    const rc = new RequestContext();
    rc.set(REQUEST_WIDGET_SPECS_KEY, 'not-a-list');
    assert.deepEqual(requestScopedTools({ requestContext: rc }), {});
  });

  it('specs set on the request context become tools named after the widget, with the server description', () => {
    const rc = new RequestContext();
    setRequestWidgetSpecs(rc, [spec]);
    const tools = requestScopedTools({ requestContext: rc }) as Record<string, { id: string; description: string }>;
    assert.deepEqual(Object.keys(tools), ['pickOne']);
    assert.equal(tools.pickOne.id, 'pickOne');
    assert.equal(tools.pickOne.description, spec.description);
  });

  it('a call suspends with the widget id and version only', async () => {
    const { ctx, suspended } = context({});
    assert.equal(await exec(ARGS, ctx), undefined);
    assert.deepEqual(suspended, [{ widget: 'pickOne', version: 3 }]);
    // widgetVersion as offered is accepted; another version is not.
    const again = context({});
    await exec({ ...ARGS, widgetVersion: 3 }, again.ctx);
    assert.equal(again.suspended.length, 1);
  });

  it('strict input: unknown fields, a wrong widgetVersion or missing props never reach the client', async () => {
    for (const input of [{ ...ARGS, html: '<b>x</b>' }, { ...ARGS, widgetVersion: 2 }, { question: 'q' }]) {
      const { ctx, suspended } = context({});
      const out = (await exec(input, ctx)) as { error?: unknown } | undefined;
      assert.equal(suspended.length, 0, JSON.stringify(input));
      assert.ok(out && (out as { error?: unknown }).error, JSON.stringify(out));
    }
  });

  it('oversize args return an error instead of suspending', async () => {
    const big = context({});
    const out = (await exec({ question: 'x'.repeat(17 * 1024), options: ['a', 'b'] }, big.ctx)) as { isError?: boolean };
    assert.equal(out?.isError, true);
    assert.equal(big.suspended.length, 0);
  });

  it('resume with an answer returns the stored tool result and records a span event without values', async () => {
    const { ctx, spans, suspended } = context({ resumeData: { kind: 'answer', record: record() } });
    const out = await exec(ARGS, ctx);
    assert.deepEqual(JSON.parse(out as string), { widget: 'pickOne', version: 3, answer: { choice: 'Yes' } });
    assert.equal(suspended.length, 0);
    assert.equal(spans.length, 1);
    assert.equal(spans[0].type, 'generic');
    assert.equal(spans[0].name, 'tourbillon.widget.answer');
    assert.equal(spans[0].metadata?.['widget.tool_call_id'], 'c1');
    assert.doesNotMatch(JSON.stringify(spans), /Yes/);
  });

  it('a throwing tracer never fails the answer', async () => {
    const ctx = {
      agent: { toolCallId: 'c1', resumeData: { kind: 'answer', record: record() } },
      tracingContext: { currentSpan: { createEventSpan: () => { throw new Error('tracer down'); } } },
    };
    assert.match(String(await exec(ARGS, ctx)), /"choice":"Yes"/);
  });

  it('resume with a dismissal returns the dismissed result', async () => {
    const { ctx, spans } = context({ resumeData: { kind: 'dismissed', toolCallId: 'c1' } });
    assert.deepEqual(JSON.parse((await exec(ARGS, ctx)) as string), { widget: 'pickOne', version: 3, dismissed: true });
    assert.equal(spans.length, 0);
  });

  it('unreadable or mismatched resume data is an error result, never an answer', async () => {
    const cases: unknown[] = [
      { kind: 'approve' },
      { kind: 'answer', record: { ...record(), extra: 1 } },
      { kind: 'answer', record: record('other-call') },
      { kind: 'answer', record: { ...record(), widget: 'otherWidget' } },
      { kind: 'answer', record: { ...record(), version: 2 } },
      { kind: 'answer', record: { ...record(), answer: { choice: 'Yes', extra: 1 } } },
    ];
    for (const resumeData of cases) {
      const { ctx, spans } = context({ resumeData });
      // Refused by Mastra's resumeSchema check ({ error }) or by the tool's own re-validation ({ isError }).
      const out = (await exec(ARGS, ctx)) as { isError?: boolean; error?: boolean } | string;
      assert.ok(typeof out === 'object' && (out.isError === true || out.error === true), JSON.stringify(resumeData));
      assert.equal(spans.length, 0);
    }
  });
});
