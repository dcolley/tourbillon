/**
 * WID-1: chat widgets as frontend tools for an AgentController run.
 *
 * A widget tool never runs anything on the server. When the model calls it, the tool suspends
 * (Mastra native tool suspension); the session reports `tool_suspended` and the AG-UI route turns it
 * into AG-UI tool-call events plus an interrupt for the client to render the widget. The user's
 * answer comes back as the resume data (built and validated by the route), and the tool returns it to
 * the model as the tool result, which Mastra memory stores in the thread with the tool call.
 *
 * Widget tools are request-scoped: the route puts the specs for the current run in the request
 * context under REQUEST_WIDGET_SPECS_KEY and the chat controller's `tools` resolver turns them into
 * tools (see requestScopedTools). Runs without that key (the REST chat routes, heartbeats) see none.
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import {
  WIDGET_MAX_ARGS_BYTES,
  WIDGET_VERSION_ARG,
  acceptWidgetAnswer,
  widgetAnswerSpanEvent,
  widgetDismissedToolResult,
  widgetJsonBytes,
  widgetAnswerToolResult,
  widgetPropsFromArgs,
  widgetResumeSchema,
  type WidgetAnswer,
  type WidgetSpec,
} from '@tourbillon/shared/widgets';

/** Request-context key holding the widget specs offered to the current run. */
export const REQUEST_WIDGET_SPECS_KEY = 'tourbillon.widgetSpecs';

interface RequestContextLike {
  get(key: string): unknown;
}

interface SpanLike {
  createEventSpan?: (options: { type: string; name: string; metadata?: Record<string, unknown> }) => unknown;
}

interface WidgetToolContext {
  agent?: {
    toolCallId?: string;
    resumeData?: unknown;
    suspend?: (payload: unknown) => Promise<void>;
  };
  tracingContext?: { currentSpan?: SpanLike };
}

/** Best effort: the answer as a span event (ids and answer shape only, never values). */
function recordAnswerSpan(context: WidgetToolContext | undefined, record: WidgetAnswer): void {
  try {
    const event = widgetAnswerSpanEvent(record);
    context?.tracingContext?.currentSpan?.createEventSpan?.({
      type: 'generic',
      name: event.name,
      metadata: event.attributes,
    });
  } catch {
    /* tracing must never fail the tool */
  }
}

const suspendPayloadSchema = z.strictObject({ widget: z.string(), version: z.number().int() });

/** The model-facing input schema: the widget's strict props plus the optional `widgetVersion` it was offered. */
function widgetInputSchema(spec: WidgetSpec): z.ZodType {
  const props = spec.propsSchema as unknown as z.ZodObject;
  if (typeof props?.extend !== 'function') return spec.propsSchema;
  return props.extend({ [WIDGET_VERSION_ARG]: z.literal(spec.version).optional() });
}

/** One suspending frontend tool for a widget spec. */
export function createWidgetTool(spec: WidgetSpec) {
  return createTool({
    id: spec.name,
    description: spec.description,
    inputSchema: widgetInputSchema(spec) as never,
    suspendSchema: suspendPayloadSchema,
    resumeSchema: widgetResumeSchema,
    execute: async (input: unknown, context?: unknown) => {
      const ctx = context as WidgetToolContext | undefined;
      const toolCallId = ctx?.agent?.toolCallId;
      const resumeData = ctx?.agent?.resumeData;
      if (resumeData !== undefined) {
        const resume = widgetResumeSchema.safeParse(resumeData);
        if (!resume.success) return { isError: true, content: 'The widget response could not be read.' };
        if (resume.data.kind === 'dismissed') return widgetDismissedToolResult(spec);
        const { record } = resume.data;
        // Defence in depth: the route already validated the answer against this spec.
        const ok =
          record.widget === spec.name &&
          record.version === spec.version &&
          (toolCallId === undefined || record.toolCallId === toolCallId) &&
          // WID-3: answers that must fit the card (e.g. one of the offered options) are checked
          // against the call's own args, which Mastra passes again on resume.
          acceptWidgetAnswer(spec, record.toolCallId, record.answer, undefined, widgetPropsFromArgs(input)).ok;
        if (!ok) return { isError: true, content: 'The widget answer was not valid.' };
        recordAnswerSpan(ctx, record);
        return widgetAnswerToolResult(record);
      }
      if (widgetJsonBytes(input) > WIDGET_MAX_ARGS_BYTES) {
        return { isError: true, content: `Widget arguments exceed ${WIDGET_MAX_ARGS_BYTES} bytes.` };
      }
      const suspend = ctx?.agent?.suspend;
      if (!suspend) return { isError: true, content: 'This widget needs an interactive chat client.' };
      await suspend({ widget: spec.name, version: spec.version });
      return undefined;
    },
  });
}

export function createWidgetTools(specs: readonly WidgetSpec[]): Record<string, ReturnType<typeof createWidgetTool>> {
  const tools: Record<string, ReturnType<typeof createWidgetTool>> = {};
  for (const spec of specs) tools[spec.name] = createWidgetTool(spec);
  return tools;
}

/** Puts the widget specs offered to this run in the request context (read by requestScopedTools). */
export function setRequestWidgetSpecs(
  requestContext: { set(key: string, value: unknown): void },
  specs: readonly WidgetSpec[],
): void {
  requestContext.set(REQUEST_WIDGET_SPECS_KEY, [...specs]);
}

/**
 * AgentController `tools` resolver: the request-scoped widget tools for this run (empty when the
 * request context carries none). Static agent tools are unaffected.
 */
export function requestScopedTools({ requestContext }: { requestContext?: RequestContextLike }) {
  const specs = requestContext?.get?.(REQUEST_WIDGET_SPECS_KEY);
  if (!Array.isArray(specs) || specs.length === 0) return {};
  return createWidgetTools(specs as WidgetSpec[]);
}
