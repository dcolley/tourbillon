/**
 * WID-1: typed, versioned registry mapping widget name + version to a compiled component and a
 * zod props schema. Anything that does not resolve (unknown name, unknown version, invalid props,
 * malformed call) resolves to a fallback reason so the caller renders the fallback tool card.
 */
import { z } from 'zod';
import {
  WIDGET_NAME_PATTERN,
  WIDGET_VERSION_ARG,
  parseWidgetToolCall,
  widgetAnswerToolResult,
  type WidgetAnswer,
} from '@tourbillon/shared/widgets';
import type { FrontendToolDefinition, WidgetDefinition, WidgetResolution, WidgetWarn } from './widget-types';

export class WidgetRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WidgetRegistryError';
  }
}

export interface WidgetRegistry {
  /** Exact name + version lookup. */
  get(name: string, version: number): WidgetDefinition | undefined;
  /** Highest registered version of a widget. */
  latest(name: string): WidgetDefinition | undefined;
  list(): WidgetDefinition[];
  /** Resolve a streamed tool call to a widget, or a fallback reason (logged as a warning). */
  resolve(toolCall: unknown): WidgetResolution;
  /** Frontend tools to declare to the agent over AG-UI (latest version of each). */
  frontendTools(): FrontendToolDefinition[];
  /** Validate an answer and build the stored answer record plus the tool result for the run. */
  acceptAnswer(
    resolution: Extract<WidgetResolution, { ok: true }>,
    answer: unknown,
    now?: Date,
  ): { ok: true; record: WidgetAnswer; toolResult: string } | { ok: false; issues: string[] };
}

const defaultWarn: WidgetWarn = (message, details) => console.warn(`[widgets] ${message}`, details);

const issuePaths = (error: z.ZodError) =>
  error.issues.map((i) => (i.path.length ? i.path.map(String).join('.') : '(root)') + `: ${i.code}`);

export function createWidgetRegistry(
  definitions: readonly WidgetDefinition[],
  opts: { warn?: WidgetWarn } = {},
): WidgetRegistry {
  const warn = opts.warn ?? defaultWarn;
  const byName = new Map<string, Map<number, WidgetDefinition>>();

  for (const def of definitions) {
    if (!WIDGET_NAME_PATTERN.test(def.name)) throw new WidgetRegistryError(`Invalid widget name: ${def.name}`);
    if (!Number.isInteger(def.version) || def.version < 1) {
      throw new WidgetRegistryError(`Invalid version for ${def.name}: ${def.version}`);
    }
    const versions = byName.get(def.name) ?? new Map<number, WidgetDefinition>();
    if (versions.has(def.version)) throw new WidgetRegistryError(`Duplicate widget: ${def.name} v${def.version}`);
    versions.set(def.version, def);
    byName.set(def.name, versions);
  }

  const latest = (name: string) => {
    const versions = byName.get(name);
    if (!versions) return undefined;
    return versions.get(Math.max(...versions.keys()));
  };

  const fallback = (
    resolution: Extract<WidgetResolution, { ok: false }>,
  ): WidgetResolution => {
    warn('tool call rendered with the fallback card', {
      reason: resolution.reason,
      toolCallId: resolution.toolCallId,
      toolName: resolution.toolName,
      ...(resolution.issues ? { issues: resolution.issues } : {}),
    });
    return resolution;
  };

  return {
    get: (name, version) => byName.get(name)?.get(version),
    latest,
    list: () => [...byName.values()].flatMap((v) => [...v.values()]).sort((a, b) => a.name.localeCompare(b.name) || a.version - b.version),

    resolve(toolCall) {
      const parsed = parseWidgetToolCall(toolCall);
      if (!parsed.ok) return fallback({ ok: false, reason: parsed.reason, toolCallId: parsed.toolCallId, toolName: parsed.toolName });
      const { call } = parsed;
      const ids = { toolCallId: call.toolCallId, toolName: call.name };
      const versions = byName.get(call.name);
      if (!versions) return fallback({ ok: false, reason: 'unknown_widget', ...ids });
      const definition = versions.get(call.version);
      if (!definition) return fallback({ ok: false, reason: 'unknown_version', ...ids });
      const props = definition.propsSchema.safeParse(call.props);
      if (!props.success) return fallback({ ok: false, reason: 'invalid_props', ...ids, issues: issuePaths(props.error) });
      return { ok: true, definition, call: { ...call, props: props.data } };
    },

    frontendTools() {
      return [...byName.keys()]
        .sort()
        .map((name) => latest(name)!)
        .filter((def) => def.frontendTool)
        .map((def) => {
          const parameters = {
            ...(z.toJSONSchema(def.propsSchema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>),
          };
          delete parameters.$schema;
          // The model must send the version it was offered.
          const properties = { ...((parameters.properties as Record<string, unknown>) ?? {}) };
          properties[WIDGET_VERSION_ARG] = { type: 'integer', const: def.version };
          return {
            name: def.name,
            description: def.description,
            parameters: { ...parameters, type: 'object', properties },
          };
        });
    },

    acceptAnswer(resolution, answer, now = new Date()) {
      const { definition, call } = resolution;
      if (!definition.answerSchema) return { ok: false, issues: ['(root): widget does not take answers'] };
      const parsed = definition.answerSchema.safeParse(answer);
      if (!parsed.success) return { ok: false, issues: issuePaths(parsed.error) };
      const record: WidgetAnswer = {
        toolCallId: call.toolCallId,
        widget: definition.name,
        version: definition.version,
        answer: parsed.data,
        answeredAt: now.toISOString(),
      };
      return { ok: true, record, toolResult: widgetAnswerToolResult(record) };
    },
  };
}

/**
 * The assistant's widget registry. Empty until the first widgets land (WID-2 approval card,
 * WID-3 question/form/confirm cards); every tool call therefore renders the fallback card.
 */
export const assistantWidgetRegistry: WidgetRegistry = createWidgetRegistry([]);
