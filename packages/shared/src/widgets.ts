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

export const MAX_WIDGET_VERSION = 1000;
export const widgetNameSchema = z.string().regex(WIDGET_NAME_PATTERN, 'Invalid widget name');
export const widgetVersionSchema = z.number().int().min(1).max(MAX_WIDGET_VERSION);

/** Size caps (UTF-8 bytes of the JSON text). Larger args are `invalid_args`; larger answers are refused. */
export const WIDGET_MAX_ARGS_BYTES = 16 * 1024;
export const WIDGET_MAX_ANSWER_BYTES = 16 * 1024;
/** Longest argument preview the fallback card shows (characters). */
export const WIDGET_MAX_PREVIEW_CHARS = 4000;

const utf8 = new TextEncoder();

/** UTF-8 byte length of `value` as JSON; Infinity when it cannot be serialized. */
export function widgetJsonBytes(value: unknown): number {
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return text === undefined ? 0 : utf8.encode(text).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** The tool call as the client sees it (AG-UI TOOL_CALL_* assembled into one call). */
export const widgetToolCallSchema = z.strictObject({
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
  if (widgetJsonBytes(args) > WIDGET_MAX_ARGS_BYTES) return fail('invalid_args');
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
export const widgetAnswerSchema = z.strictObject({
  toolCallId: z.string().min(1).max(200),
  widget: widgetNameSchema,
  version: widgetVersionSchema,
  answer: z.unknown().refine((v) => widgetJsonBytes(v) <= WIDGET_MAX_ANSWER_BYTES, 'Answer too large'),
  answeredAt: z.iso.datetime(),
});
export type WidgetAnswer = z.infer<typeof widgetAnswerSchema>;

/** Tool-result content for the run (AG-UI tool message `content`). */
export function widgetAnswerToolResult(answer: WidgetAnswer): string {
  return JSON.stringify({ widget: answer.widget, version: answer.version, answer: answer.answer });
}

/**
 * A widget's contract without its component: what the server needs to declare the widget to the
 * agent as a frontend tool and to validate answers. The client registry pairs each spec with its
 * compiled component (WidgetDefinition extends this).
 *
 * Rule (checked at registration): `propsSchema` is a `z.strictObject`, and every object inside the
 * props and answer schemas is strict too, so unknown keys are refused instead of silently stripped.
 * Every value must also have a described type: schemas that accept any value (`z.unknown()`,
 * `z.any()`, `z.custom()`, and records or arrays of those) are refused at any depth. Records
 * (`z.record`) with typed values are allowed: their keys are explicit.
 */
export interface WidgetSpec<P = any, A = any> {
  name: string;
  version: number;
  /** Shown to the model when the widget is declared as a frontend tool. */
  description: string;
  propsSchema: z.ZodType<P>;
  /** Present for interactive widgets: answers are validated before they go back to the run. */
  answerSchema?: z.ZodType<A>;
  /** Declared to the agent as an AG-UI frontend tool (latest version only). */
  frontendTool?: boolean;
}

/** AG-UI `Tool` shape (name, description, JSON Schema parameters). */
export interface WidgetFrontendTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> | undefined {
  try {
    const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
    delete json.$schema;
    return json;
  } catch {
    return undefined;
  }
}

/** Paths of objects in a JSON Schema that accept unknown keys. */
function looseObjectPaths(node: unknown, path: string, out: string[]): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((child, i) => looseObjectPaths(child, `${path}[${i}]`, out));
    return;
  }
  const n = node as Record<string, unknown>;
  if (n.properties && typeof n.properties === 'object' && n.additionalProperties !== false) out.push(path || '(root)');
  for (const [key, child] of Object.entries(n)) {
    if (key === 'properties' && child && typeof child === 'object') {
      for (const [prop, sub] of Object.entries(child)) looseObjectPaths(sub, path ? `${path}.${prop}` : prop, out);
    } else if (key !== 'properties' && child && typeof child === 'object') {
      looseObjectPaths(child, path, out);
    }
  }
}

/** Keywords that constrain a JSON Schema value; a schema with none of them accepts anything. */
const CONSTRAINING_KEYWORDS = ['type', 'const', 'enum', 'anyOf', 'oneOf', 'allOf', '$ref', 'not'];

/** Paths of sub-schemas that accept any value (`{}` or `true`, e.g. z.unknown / z.any / z.custom). */
function unconstrainedPaths(node: unknown, path: string, out: string[]): void {
  const at = path || '(root)';
  if (node === true) {
    out.push(at);
    return;
  }
  if (!node || typeof node !== 'object' || Array.isArray(node)) return;
  const n = node as Record<string, unknown>;
  if (!CONSTRAINING_KEYWORDS.some((k) => k in n)) {
    out.push(at);
    return;
  }
  const child = (sub: unknown, p: string) => unconstrainedPaths(sub, p, out);
  if (n.properties && typeof n.properties === 'object') {
    for (const [prop, sub] of Object.entries(n.properties)) child(sub, path ? `${path}.${prop}` : prop);
  }
  if (Array.isArray(n.items)) n.items.forEach((sub, i) => child(sub, `${path}[${i}]`));
  else if (n.items !== undefined) child(n.items, `${path}[]`);
  if (Array.isArray(n.prefixItems)) n.prefixItems.forEach((sub, i) => child(sub, `${path}[${i}]`));
  // Objects with properties and open extra keys are already reported by the strict-object rule.
  if (!n.properties && n.additionalProperties !== undefined && n.additionalProperties !== false) {
    child(n.additionalProperties, `${path}{}`);
  }
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    if (Array.isArray(n[key])) (n[key] as unknown[]).forEach((sub) => child(sub, path));
  }
  for (const key of ['$defs', 'definitions'] as const) {
    const defs = n[key];
    if (defs && typeof defs === 'object') for (const [name, sub] of Object.entries(defs)) child(sub, `#${name}`);
  }
}

/** Problems with a widget schema under the strict rule (empty when it complies). */
export function widgetSchemaProblems(schema: z.ZodType, opts: { mustBeObject?: boolean } = {}): string[] {
  const json = jsonSchemaOf(schema);
  if (!json) return ['(root): schema cannot be described as JSON Schema'];
  const problems: string[] = [];
  if (opts.mustBeObject && (json.type !== 'object' || !json.properties)) problems.push('(root): must be a z.strictObject');
  const loose: string[] = [];
  looseObjectPaths(json, '', loose);
  for (const p of loose) problems.push(`${p}: object must be strict (z.strictObject)`);
  const untyped: string[] = [];
  unconstrainedPaths(json, '', untyped);
  for (const p of untyped) problems.push(`${p}: value must have a described type (not unknown / any / custom)`);
  return problems;
}

/** Everything wrong with a spec (empty when it can be registered). */
export function widgetSpecProblems(spec: WidgetSpec): string[] {
  const problems: string[] = [];
  if (!WIDGET_NAME_PATTERN.test(spec.name)) problems.push(`Invalid widget name: ${spec.name}`);
  if (!widgetVersionSchema.safeParse(spec.version).success) {
    problems.push(`Invalid version for ${spec.name}: ${spec.version} (1..${MAX_WIDGET_VERSION})`);
  }
  for (const p of widgetSchemaProblems(spec.propsSchema, { mustBeObject: true })) {
    problems.push(`${spec.name} v${spec.version} props ${p}`);
  }
  if (spec.answerSchema) {
    for (const p of widgetSchemaProblems(spec.answerSchema)) problems.push(`${spec.name} v${spec.version} answer ${p}`);
  }
  if (spec.propsSchema && jsonSchemaOf(spec.propsSchema)?.properties) {
    const props = jsonSchemaOf(spec.propsSchema)!.properties as Record<string, unknown>;
    if (WIDGET_VERSION_ARG in props) problems.push(`${spec.name}: props must not use the reserved key ${WIDGET_VERSION_ARG}`);
  }
  return problems;
}

/** The AG-UI frontend tool declaration for a spec: its props plus the `widgetVersion` it was offered. */
export function widgetFrontendTool(spec: WidgetSpec): WidgetFrontendTool {
  const parameters = { ...(jsonSchemaOf(spec.propsSchema) ?? { type: 'object', properties: {} }) };
  const properties = { ...((parameters.properties as Record<string, unknown>) ?? {}) };
  properties[WIDGET_VERSION_ARG] = { type: 'integer', const: spec.version };
  return { name: spec.name, description: spec.description, parameters: { ...parameters, type: 'object', properties } };
}

const issuePaths = (error: z.ZodError) =>
  error.issues.map((i) => (i.path.length ? i.path.map(String).join('.') : '(root)') + `: ${i.code}`);

export type WidgetAnswerResult = { ok: true; record: WidgetAnswer; toolResult: string } | { ok: false; issues: string[] };

/**
 * Validate a user's answer against the spec (size cap, then the strict answer schema) and build the
 * stored record plus the tool result for the run. Issues name paths and codes only, never values.
 */
export function acceptWidgetAnswer(
  spec: WidgetSpec,
  toolCallId: string,
  answer: unknown,
  now: Date = new Date(),
): WidgetAnswerResult {
  if (!spec.answerSchema) return { ok: false, issues: ['(root): widget does not take answers'] };
  if (widgetJsonBytes(answer) > WIDGET_MAX_ANSWER_BYTES) return { ok: false, issues: ['(root): too_big'] };
  const parsed = spec.answerSchema.safeParse(answer);
  if (!parsed.success) return { ok: false, issues: issuePaths(parsed.error) };
  const record = widgetAnswerSchema.safeParse({
    toolCallId,
    widget: spec.name,
    version: spec.version,
    answer: parsed.data,
    answeredAt: now.toISOString(),
  });
  if (!record.success) return { ok: false, issues: issuePaths(record.error) };
  return { ok: true, record: record.data, toolResult: widgetAnswerToolResult(record.data) };
}

/** Name + version lookup over validated specs. Throws on an invalid or duplicate spec. */
export function createWidgetSpecIndex<S extends WidgetSpec>(
  specs: readonly S[],
  makeError: (message: string) => Error = (m) => new Error(m),
) {
  const byName = new Map<string, Map<number, S>>();
  for (const spec of specs) {
    const problems = widgetSpecProblems(spec);
    if (problems.length > 0) throw makeError(problems[0]);
    const versions = byName.get(spec.name) ?? new Map<number, S>();
    if (versions.has(spec.version)) throw makeError(`Duplicate widget: ${spec.name} v${spec.version}`);
    versions.set(spec.version, spec);
    byName.set(spec.name, versions);
  }
  const latest = (name: string): S | undefined => {
    const versions = byName.get(name);
    return versions ? versions.get(Math.max(...versions.keys())) : undefined;
  };
  return {
    get: (name: string, version: number): S | undefined => byName.get(name)?.get(version),
    latest,
    has: (name: string) => byName.has(name),
    list: (): S[] =>
      [...byName.values()].flatMap((v) => [...v.values()]).sort((a, b) => a.name.localeCompare(b.name) || a.version - b.version),
    /** Latest version of each frontend-tool widget, sorted by name. */
    frontendSpecs: (): S[] => [...byName.keys()].sort().map((n) => latest(n)!).filter((s) => s.frontendTool),
  };
}
export type WidgetSpecIndex<S extends WidgetSpec = WidgetSpec> = ReturnType<typeof createWidgetSpecIndex<S>>;

/**
 * How the user's response comes back to a suspended widget tool (the Mastra resume data). Built by
 * the server from a validated answer; never taken from the client as-is.
 */
export const widgetResumeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('answer'), record: widgetAnswerSchema }),
  z.strictObject({ kind: z.literal('dismissed'), toolCallId: z.string().min(1).max(200) }),
]);
export type WidgetResume = z.infer<typeof widgetResumeSchema>;

/** Tool result when the user dismissed the card without answering. */
export function widgetDismissedToolResult(spec: Pick<WidgetSpec, 'name' | 'version'>): string {
  return JSON.stringify({ widget: spec.name, version: spec.version, dismissed: true });
}

/** A stored answer read back from a thread's tool results. */
export function parseStoredWidgetAnswer(
  toolCallId: string,
  toolName: string,
  result: unknown,
): { toolCallId: string; widget: string; version: number; answer: unknown } | null {
  let value = result;
  if (typeof value === 'string') {
    if (widgetJsonBytes(value) > WIDGET_MAX_ANSWER_BYTES * 2) return null;
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  const parsed = z
    .strictObject({ widget: widgetNameSchema, version: widgetVersionSchema, answer: z.unknown() })
    .safeParse(value);
  if (!parsed.success || parsed.data.widget !== toolName || !('answer' in (value as object))) return null;
  return { toolCallId, widget: parsed.data.widget, version: parsed.data.version, answer: parsed.data.answer };
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
