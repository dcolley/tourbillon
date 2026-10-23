/**
 * OBS-1: assistant-view trace attributes, trace id on saved assistant messages, and an end-to-end
 * turn on a real AgentController session (stub model, in-memory storage) exported through the
 * production span output processors: the trace carries the turn's model and tool spans under the
 * chosen trace id, and known secret values are redacted from tool input/output spans.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { AgentController } from '@mastra/core/agent-controller';
import { Agent } from '@mastra/core/agent';
import { TracingEventType, type AnyExportedSpan, type TracingEvent } from '@mastra/core/observability';
import { InMemoryStore } from '@mastra/core/storage';
import { MastraLanguageModelV2Mock, simulateReadableStream } from '@mastra/core/test-utils/llm-mock';
import { createTool } from '@mastra/core/tools';
import { Memory } from '@mastra/memory';
import { BaseExporter, Observability } from '@mastra/observability';
import { z } from 'zod';
import { buildSpanOutputProcessors } from '../mastra-instance';
import { clearKnownSecretValues, registerKnownSecretValues } from './secret-value-redaction';
import {
  ASSISTANT_TRACE_VIEW,
  buildAssistantTracingOptions,
  isTraceId,
  messageTraceId,
} from './assistant-tracing';

const base = {
  companyId: 'company-1',
  agentId: 'agent-1',
  agentUrlKey: 'helper',
  threadId: 'thread-1',
  provider: 'provider-1',
  model: 'example/model-a',
  aguiRunId: 'run-1',
};

describe('OBS-1 buildAssistantTracingOptions', () => {
  it('sets companyId, agentId, threadId, view=assistant, provider and model on the root span', () => {
    const opts = buildAssistantTracingOptions(base, { enabled: true });
    assert.ok(opts);
    assert.ok(isTraceId(opts.traceId), 'hex trace id');
    assert.equal(opts.traceId.length, 32);
    assert.deepEqual(opts.metadata, {
      companyId: 'company-1',
      agentId: 'agent-1',
      threadId: 'thread-1',
      view: ASSISTANT_TRACE_VIEW,
      agentUrlKey: 'helper',
      provider: 'provider-1',
      model: 'example/model-a',
      aguiRunId: 'run-1',
    });
    assert.deepEqual(opts.tags, ['company:company-1', 'agent:helper', 'view:assistant']);
  });

  it('a new trace id per call; a supplied hex id is reused', () => {
    const a = buildAssistantTracingOptions(base, { enabled: true })!;
    const b = buildAssistantTracingOptions(base, { enabled: true })!;
    assert.notEqual(a.traceId, b.traceId);
    const fixed = buildAssistantTracingOptions({ ...base, traceId: 'abc123' }, { enabled: true })!;
    assert.equal(fixed.traceId, 'abc123');
  });

  it('rejects a non-hex trace id', () => {
    assert.throws(() => buildAssistantTracingOptions({ ...base, traceId: 'not-a-trace' }, { enabled: true }));
  });

  it('omits unset optional attributes instead of writing empty values', () => {
    const opts = buildAssistantTracingOptions(
      { companyId: 'c', agentId: 'a', threadId: 't', provider: null, model: '  ', agentUrlKey: undefined },
      { enabled: true },
    )!;
    assert.deepEqual(opts.metadata, { companyId: 'c', agentId: 'a', threadId: 't', view: 'assistant' });
    assert.deepEqual(opts.tags, ['company:c', 'agent:a', 'view:assistant']);
  });

  it('undefined when no span exporter is configured (nothing to link to)', () => {
    assert.equal(buildAssistantTracingOptions(base, { enabled: false }), undefined);
  });
});

describe('OBS-1 messageTraceId', () => {
  it('reads content.metadata.traceId and ignores junk', () => {
    assert.equal(messageTraceId({ content: { metadata: { traceId: 'abc' } } }), 'abc');
    assert.equal(messageTraceId({ content: { metadata: { traceId: '<script>' } } }), undefined);
    assert.equal(messageTraceId({ content: 'text' }), undefined);
    assert.equal(messageTraceId({ content: undefined }), undefined);
    assert.equal(messageTraceId({}), undefined);
  });
});

class CapturingExporter extends BaseExporter {
  name = 'obs1-capturing-exporter';
  readonly ended: AnyExportedSpan[] = [];
  protected async _exportTracingEvent(event: TracingEvent): Promise<void> {
    if (event.type === TracingEventType.SPAN_ENDED) this.ended.push(event.exportedSpan);
  }
}

const SECRET = 'Fixture-Obs1-Secret-Value-7c1e'; // fake, registered as a known secret below
const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

describe('OBS-1 assistant turn on a real session (stub model)', () => {
  let observability: Observability | undefined;

  afterEach(async () => {
    await observability?.shutdown();
    observability = undefined;
    clearKnownSecretValues();
  });

  it('model and tool spans share the run trace id; secrets are redacted; trace id lands on the assistant message', async () => {
    registerKnownSecretValues('agent:agent-1', [{ secrets: { OBS1_TOKEN: SECRET } }]);
    const exporter = new CapturingExporter();
    observability = new Observability({
      configs: {
        default: {
          serviceName: 'tourbillon-test',
          spanOutputProcessors: buildSpanOutputProcessors(),
          exporters: [exporter],
        },
      },
    });

    let calls = 0;
    const model = new MastraLanguageModelV2Mock({
      doStream: async () => {
        calls += 1;
        const input = JSON.stringify({ token: SECRET });
        const chunks =
          calls === 1
            ? [
                { type: 'stream-start', warnings: [] },
                { type: 'tool-input-start', id: 'call-1', toolName: 'lookup' },
                { type: 'tool-input-delta', id: 'call-1', delta: input },
                { type: 'tool-input-end', id: 'call-1' },
                { type: 'tool-call', toolCallId: 'call-1', toolName: 'lookup', input },
                { type: 'finish', finishReason: 'tool-calls', usage },
              ]
            : [
                { type: 'stream-start', warnings: [] },
                { type: 'text-start', id: 't1' },
                { type: 'text-delta', id: 't1', delta: 'All done.' },
                { type: 'text-end', id: 't1' },
                { type: 'finish', finishReason: 'stop', usage },
              ];
        return { stream: simulateReadableStream({ chunks }), rawCall: { rawPrompt: null, rawSettings: {} } };
      },
    });
    const lookup = createTool({
      id: 'lookup',
      description: 'test tool',
      inputSchema: z.object({}).passthrough(),
      execute: async () => ({ echoed: `value=${SECRET}` }),
    });
    const agent = new Agent({ id: 'obs1-agent', name: 'Obs1', instructions: 'Test agent.', model, tools: { lookup } });
    const storage = new InMemoryStore();
    const controller = new AgentController({
      id: 'obs1-controller',
      storage,
      memory: new Memory({ storage, options: { lastMessages: 20, semanticRecall: false } }),
      agent,
      modes: [{ id: 'default', name: 'Default', default: true, defaultModelId: 'stub/stub' }],
      initialState: { yolo: true },
      observability,
    } as never);
    await controller.init();
    const session = await controller.createSession({ resourceId: 'company-1:chat:free', id: 'company-1:chat:free', ownerId: controller.id } as never);
    await session.thread.create({});
    const threadId = session.thread.getId();
    assert.ok(threadId, 'thread bound');

    const tracing = buildAssistantTracingOptions({ ...base, threadId }, { enabled: true })!;
    await session.sendMessage({ content: 'Look it up', tracingOptions: tracing } as never);
    await observability.flush();

    const inTrace = exporter.ended.filter((s) => s.traceId === tracing.traceId);
    assert.ok(inTrace.length > 0, 'spans exported under the run trace id');
    assert.equal(
      exporter.ended.filter((s) => s.traceId !== tracing.traceId).length,
      0,
      'no spans of this turn outside the run trace',
    );
    const types = new Set(inTrace.map((s) => String(s.type)));
    assert.ok(types.has('model_generation'), `model span present (got ${[...types].join(', ')})`);
    assert.ok(types.has('tool_call'), `tool span present (got ${[...types].join(', ')})`);

    const root = inTrace.find((s) => s.isRootSpan);
    assert.ok(root, 'root span');
    const rootMeta = root.metadata as Record<string, unknown>;
    for (const [k, v] of Object.entries(tracing.metadata)) assert.equal(rootMeta[k], v, `root metadata ${k}`);
    assert.deepEqual(root.tags, tracing.tags);

    const tool = inTrace.find((s) => String(s.type) === 'tool_call')!;
    const toolJson = JSON.stringify({ input: tool.input, output: tool.output });
    assert.ok(!toolJson.includes(SECRET), 'tool span input/output carry no secret value');
    assert.ok(toolJson.includes('[REDACTED:OBS1_TOKEN]'), 'redaction marker present');
    assert.ok(!JSON.stringify(inTrace).includes(SECRET), 'no span of the trace carries the secret value');

    // Mastra stamps the run trace id on the saved assistant message; the thread messages API
    // (session.thread.listMessages, used by the hydrate route) returns it.
    const saved = (await session.thread.listMessages({ threadId })) as Array<{ role: string; content?: unknown }>;
    const assistant = saved.filter((m) => m.role === 'assistant');
    assert.ok(assistant.length > 0, 'assistant message saved');
    for (const m of assistant) assert.equal(messageTraceId(m), tracing.traceId, 'assistant message carries the run trace id');
    for (const m of saved.filter((x) => x.role !== 'assistant')) assert.equal(messageTraceId(m), undefined);
  });
});
