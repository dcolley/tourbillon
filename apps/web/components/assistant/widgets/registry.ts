/**
 * WID-1: typed, versioned registry mapping widget name + version to a compiled component and a
 * zod props schema. Anything that does not resolve (unknown name, unknown version, invalid props,
 * malformed call) resolves to a fallback reason so the caller renders the fallback tool card.
 */
import {
  acceptWidgetAnswer,
  createWidgetSpecIndex,
  parseWidgetToolCall,
  widgetFrontendTool,
  type WidgetAnswer,
} from '@tourbillon/shared/widgets';
import type { FrontendToolDefinition, WidgetDefinition, WidgetResolution, WidgetWarn } from './widget-types';
import { chatCardDefinitions } from './chat-cards';
import { approvalCardSpec } from './specs';
import { ApprovalCardWidget } from './approval-card';

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

const issuePaths = (error: { issues: Array<{ path: PropertyKey[]; code: string }> }) =>
  error.issues.map((i) => (i.path.length ? i.path.map(String).join('.') : '(root)') + `: ${i.code}`);

/**
 * Definitions are checked at registration (name, version 1..1000, duplicates) and must follow the
 * strict-schema rule (see `WidgetSpec` in @tourbillon/shared/widgets): props are a `z.strictObject`
 * and every object in the props and answer schemas is strict, so unknown keys are refused.
 */
export function createWidgetRegistry(
  definitions: readonly WidgetDefinition[],
  opts: { warn?: WidgetWarn } = {},
): WidgetRegistry {
  const warn = opts.warn ?? defaultWarn;
  const index = createWidgetSpecIndex(definitions, (m) => new WidgetRegistryError(m));

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
    get: index.get,
    latest: index.latest,
    list: index.list,

    resolve(toolCall) {
      const parsed = parseWidgetToolCall(toolCall);
      if (!parsed.ok) return fallback({ ok: false, reason: parsed.reason, toolCallId: parsed.toolCallId, toolName: parsed.toolName });
      const { call } = parsed;
      const ids = { toolCallId: call.toolCallId, toolName: call.name };
      if (!index.has(call.name)) return fallback({ ok: false, reason: 'unknown_widget', ...ids });
      const definition = index.get(call.name, call.version);
      if (!definition) return fallback({ ok: false, reason: 'unknown_version', ...ids });
      const props = definition.propsSchema.safeParse(call.props);
      if (!props.success) return fallback({ ok: false, reason: 'invalid_props', ...ids, issues: issuePaths(props.error) });
      return { ok: true, definition, call: { ...call, props: props.data } };
    },

    frontendTools() {
      return index.frontendSpecs().map(widgetFrontendTool);
    },

    acceptAnswer(resolution, answer, now = new Date()) {
      // WID-3: answers are also checked against the card's own props (same check as the server).
      return acceptWidgetAnswer(resolution.definition, resolution.call.toolCallId, answer, now, resolution.call.props);
    },
  };
}

/**
 * The assistant's widget registry: the WID-2 approval card and the WID-3 question, choice, form and
 * confirm cards. Any other tool call renders the fallback card.
 *
 * Each definition is `{ ...spec, component }` for a spec in `assistantWidgetSpecs` (./specs), the
 * component-free list the AG-UI route uses to offer widget tools and validate answers. The two
 * lists must match (registry test).
 */
export const assistantWidgetRegistry: WidgetRegistry = createWidgetRegistry([
  { ...approvalCardSpec, component: ApprovalCardWidget },
  ...chatCardDefinitions,
]);
