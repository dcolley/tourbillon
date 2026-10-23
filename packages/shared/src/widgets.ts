/**
 * WID-1: shared widget schemas for chat widgets (AG-UI tool calls rendered as UI cards).
 *
 * A widget tool call is an AG-UI tool call whose tool name is the widget name. Its JSON args are
 * the widget props, plus an optional reserved `widgetVersion` (integer, default 1) that selects
 * the registered version. Answers go back to the run as the tool result.
 */
import { z } from 'zod';

/** Widget names are also tool names declared to the model: camelCase, provider-safe. */
export const WIDGET_NAME_PATTERN = /^[a-z][A-Za-z0-9]{0,63}$/;
export const WIDGET_VERSION_ARG = 'widgetVersion';
export const DEFAULT_WIDGET_VERSION = 1;

export const widgetNameSchema = z.string().regex(WIDGET_NAME_PATTERN, 'Invalid widget name');
export const widgetVersionSchema = z.number().int().min(1).max(1000);

/** The tool call as the client sees it (AG-UI TOOL_CALL_* assembled into one call). */
export const widgetToolCallSchema = z.object({
  toolCallId: z.string().min(1).max(200),
  toolName: z.string().min(1).max(200),
  /** JSON args: an object or its serialized JSON string (as streamed by AG-UI). */
  args: z.union([z.record(z.string(), z.unknown()), z.string()]),
});
export type WidgetToolCall = z.infer<typeof widgetToolCallSchema>;

export interface ParsedWidgetCall {
  toolCallId: string;
  name: string;
  version: number;
  props: Record<string, unknown>;
}

export type WidgetCallParseError = 'invalid_call' | 'invalid_args' | 'invalid_name' | 'invalid_version';

export type WidgetCallParseResult =
  | { ok: true; call: ParsedWidgetCall }
  | { ok: false; reason: WidgetCallParseError; toolCallId?: string; toolName?: string };

/** Split a tool call into widget name, version and props. Never throws. */
export function parseWidgetToolCall(input: unknown): WidgetCallParseResult {
  const base = widgetToolCallSchema.safeParse(input);
  if (!base.success) {
    const raw = (input ?? {}) as { toolCallId?: unknown; toolName?: unknown };
    return {
      ok: false,
      reason: 'invalid_call',
      toolCallId: typeof raw.toolCallId === 'string' ? raw.toolCallId : undefined,
      toolName: typeof raw.toolName === 'string' ? raw.toolName : undefined,
    };
  }
  const { toolCallId, toolName } = base.data;
  const fail = (reason: WidgetCallParseError): WidgetCallParseResult => ({ ok: false, reason, toolCallId, toolName });

  let args: unknown = base.data.args;
  if (typeof args === 'string') {
    try {
      args = args.trim() === '' ? {} : JSON.parse(args);
    } catch {
      return fail('invalid_args');
    }
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return fail('invalid_args');
  if (!WIDGET_NAME_PATTERN.test(toolName)) return fail('invalid_name');

  const { [WIDGET_VERSION_ARG]: rawVersion, ...props } = args as Record<string, unknown>;
  const version = rawVersion === undefined ? DEFAULT_WIDGET_VERSION : widgetVersionSchema.safeParse(rawVersion);
  if (typeof version !== 'number' && !version.success) return fail('invalid_version');

  return {
    ok: true,
    call: { toolCallId, name: toolName, version: typeof version === 'number' ? version : version.data, props },
  };
}

/** A user's answer to a widget, as stored with the thread and returned to the run. */
export const widgetAnswerSchema = z.object({
  toolCallId: z.string().min(1).max(200),
  widget: widgetNameSchema,
  version: widgetVersionSchema,
  answer: z.unknown(),
  answeredAt: z.iso.datetime(),
});
export type WidgetAnswer = z.infer<typeof widgetAnswerSchema>;

/** Tool-result content for the run (AG-UI tool message `content`). */
export function widgetAnswerToolResult(answer: WidgetAnswer): string {
  return JSON.stringify({ widget: answer.widget, version: answer.version, answer: answer.answer });
}

/**
 * Span event for an answered widget. Carries identifiers and the answer's shape only, never the
 * answer values (answers can hold user-entered data).
 */
export function widgetAnswerSpanEvent(answer: WidgetAnswer): {
  name: 'tourbillon.widget.answer';
  attributes: Record<string, string | number | boolean>;
} {
  const value = answer.answer;
  const kind = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  return {
    name: 'tourbillon.widget.answer',
    attributes: {
      'widget.name': answer.widget,
      'widget.version': answer.version,
      'widget.tool_call_id': answer.toolCallId,
      'widget.answer.kind': kind,
      ...(kind === 'object' ? { 'widget.answer.fields': Object.keys(value as object).length } : {}),
      ...(kind === 'array' ? { 'widget.answer.items': (value as unknown[]).length } : {}),
    },
  };
}

/** Why a tool call is shown as the fallback card instead of its widget. */
export type WidgetFallbackReason =
  | WidgetCallParseError
  | 'unknown_widget'
  | 'unknown_version'
  | 'invalid_props';

export const WIDGET_FALLBACK_MESSAGES: Record<WidgetFallbackReason, string> = {
  invalid_call: 'This tool call is incomplete.',
  invalid_args: 'The tool arguments could not be read.',
  invalid_name: 'This tool has no card.',
  invalid_version: 'The card version is not valid.',
  unknown_widget: 'This tool has no card.',
  unknown_version: 'This card version is not available.',
  invalid_props: 'The card data was not valid.',
};

const SENSITIVE_KEY = /(pass(word|phrase)?|secret|token|api[-_]?key|authori[sz]ation|cookie|credential|private[-_]?key)/i;
export const WIDGET_REDACTED = '[redacted]';

/**
 * Copy of a JSON-like value with values under sensitive-looking keys replaced, for display in
 * the fallback card. Cycles and depth beyond 8 are cut.
 */
export function redactWidgetValue(value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 8 || seen.has(value)) return '[…]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => redactWidgetValue(v, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY.test(key) ? WIDGET_REDACTED : redactWidgetValue(child, depth + 1, seen);
  }
  return out;
}
