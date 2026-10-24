/**
 * Test support for AGUI-1 (not imported by app code): a real Mastra AgentController + Session on
 * in-memory storage, driven by a scripted stub model instead of an LLM. Loads @mastra/core through
 * packages/mastra so tests use the same copy the chat controller uses.
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';

const mastraRequire = createRequire(join(__dirname, '../../../../../packages/mastra/package.json'));

export type StubChunk = Record<string, unknown>;
/** One model call: the stream chunks to return. */
export type StubTurn = StubChunk[];

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

export const stubText = (id: string, parts: string[]): StubChunk[] => [
  { type: 'text-start', id },
  ...parts.map((delta) => ({ type: 'text-delta', id, delta })),
  { type: 'text-end', id },
];

export const stubToolCall = (toolCallId: string, toolName: string, args: unknown): StubChunk[] => {
  const input = JSON.stringify(args);
  return [
    { type: 'tool-input-start', id: toolCallId, toolName },
    { type: 'tool-input-delta', id: toolCallId, delta: input },
    { type: 'tool-input-end', id: toolCallId },
    { type: 'tool-call', toolCallId, toolName, input },
  ];
};

export interface StubControllerOptions {
  /**
   * Picks the chunks for each model call. `call` counts from 1; `prompt` is the model prompt
   * (roles + content) so a script can branch on tool results or the latest user text.
   */
  script: (call: number, prompt: Array<{ role: string; content: unknown }>) => StubTurn;
  /** Delay between chunks (ms), to leave room for mid-run steer / follow-up / abort. */
  chunkDelayMs?: number;
  /** Server tools registered on the agent: id → execute. */
  tools?: Record<string, (input: any) => Promise<unknown> | unknown>;
  /** OBS-1: Mastra Observability instance (e.g. with a capturing exporter), as the chat controller passes when tracing is on. */
  observability?: unknown;
}

/** A captured (ended) tracing span: the fields the OBS-1 tests read. */
export interface CapturedSpan {
  traceId: string;
  type: string;
  isRootSpan: boolean;
  metadata?: Record<string, unknown>;
  input?: unknown;
  output?: unknown;
}

/**
 * OBS-1 test support: a Mastra Observability instance whose only exporter records ended spans,
 * loaded from the same @mastra copy as the controller. Pass `observability` to createStubAgentController.
 */
export function createCapturingObservability() {
  const { BaseExporter, Observability } = mastraRequire('@mastra/observability');
  const { TracingEventType } = mastraRequire('@mastra/core/observability');
  const ended: CapturedSpan[] = [];
  class CapturingExporter extends BaseExporter {
    name = 'stub-capturing-exporter';
    async _exportTracingEvent(event: { type: string; exportedSpan: CapturedSpan }) {
      if (event.type === TracingEventType.SPAN_ENDED) ended.push(event.exportedSpan);
    }
  }
  const observability = new Observability({
    configs: { default: { serviceName: 'tourbillon-test', exporters: [new CapturingExporter()] } },
  });
  return { observability, ended, flush: (): Promise<void> => observability.flush() };
}

export async function createStubAgentController(options: StubControllerOptions) {
  const { AgentController } = mastraRequire('@mastra/core/agent-controller');
  const { Agent } = mastraRequire('@mastra/core/agent');
  const { MastraLanguageModelV2Mock, simulateReadableStream } = mastraRequire('@mastra/core/test-utils/llm-mock');
  const { InMemoryStore } = mastraRequire('@mastra/core/storage');
  const { createTool } = mastraRequire('@mastra/core/tools');
  const { z } = mastraRequire('zod');
  const { Memory } = mastraRequire('@mastra/memory');

  let calls = 0;
  const prompts: Array<Array<{ role: string; content: unknown }>> = [];
  const model = new MastraLanguageModelV2Mock({
    doStream: async (opts: { prompt: Array<{ role: string; content: unknown }> }) => {
      calls += 1;
      prompts.push(opts.prompt);
      const turn = options.script(calls, opts.prompt);
      const hasToolCall = turn.some((c) => c.type === 'tool-call');
      const chunks = [
        { type: 'stream-start', warnings: [] },
        ...turn,
        { type: 'finish', finishReason: hasToolCall ? 'tool-calls' : 'stop', usage },
      ];
      return {
        stream: simulateReadableStream({ chunks, chunkDelayInMs: options.chunkDelayMs ?? 0 }),
        rawCall: { rawPrompt: null, rawSettings: {} },
      };
    },
  });

  const tools: Record<string, unknown> = {};
  for (const [id, execute] of Object.entries(options.tools ?? {})) {
    tools[id] = createTool({
      id,
      description: `${id} (test tool)`,
      inputSchema: z.object({}).passthrough(),
      execute: async (input: unknown) => execute(input),
    });
  }

  const agent = new Agent({ id: 'stub-agent', name: 'Stub', instructions: 'Test agent.', model, tools });
  const storage = new InMemoryStore();
  const controller = new AgentController({
    id: 'stub-controller',
    storage,
    // Thread history (lastMessages) like the chat controller's memory, on the same in-memory store.
    memory: new Memory({ storage, options: { lastMessages: 20, semanticRecall: false } }),
    agent,
    modes: [{ id: 'default', name: 'Default', default: true, defaultModelId: 'stub/stub' }],
    initialState: { yolo: true },
    ...(options.observability ? { observability: options.observability } : {}),
  });
  await controller.init();
  return {
    controller,
    agent,
    get modelCalls() {
      return calls;
    },
    prompts,
    /** Same shape as registry.getChatSession → controller.createSession. */
    createSession: (resourceId: string, scope?: string) =>
      controller.createSession({
        resourceId,
        id: scope ? `${resourceId}::${scope}` : resourceId,
        ownerId: controller.id,
        scope,
      }),
  };
}

export type StubAgentController = Awaited<ReturnType<typeof createStubAgentController>>;

/** Lowest-common text of a prompt message, for scripts that branch on user input. */
export function promptText(message: { content: unknown } | undefined): string {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('');
  }
  return '';
}

/** A Mastra RequestContext (what createChatRequestContext returns), from the same @mastra/core copy. */
export function createStubRequestContext(entries: Record<string, unknown> = {}) {
  const { RequestContext } = mastraRequire('@mastra/core/request-context');
  const ctx = new RequestContext();
  for (const [k, v] of Object.entries(entries)) ctx.set(k, v);
  return ctx;
}
