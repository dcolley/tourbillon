/**
 * WID-1: chat widgets over AG-UI (server side).
 *
 * - Offer: a widget is offered to a run as a frontend tool only when the client declares it in
 *   `RunAgentInput.tools` (by name) AND the server knows its spec (assistantWidgetSpecs). The client's
 *   description / parameters are ignored: the model sees the server spec. Declared tools the server
 *   does not know are ignored (not an error), so a client may declare tools for other agents.
 * - Call: the widget tool suspends; the client gets TOOL_CALL_START / ARGS / END, the
 *   `tourbillon.tool_suspended` CUSTOM event and a RUN_FINISHED interrupt (reason `tool_suspended`).
 * - Answer: the client sends an AG-UI `resume` entry `{ interruptId: toolCallId, status: 'resolved',
 *   payload: { answer } }` (or `status: 'cancelled'` to dismiss). The route validates the answer
 *   against the server spec (size cap, strict schema), then resumes the suspended tool on a new
 *   streaming run; the tool result (`{ widget, version, answer }`) is stored in the thread by Mastra
 *   memory with the tool call, and read back by listWidgetAnswers.
 */
import { z } from 'zod';
import {
  acceptWidgetAnswer,
  parseStoredWidgetAnswer,
  type WidgetResume,
  type WidgetSpec,
  type WidgetSpecIndex,
} from '@tourbillon/shared/widgets';

/** At most this many declared client tools are looked at. */
const MAX_DECLARED_TOOLS = 200;

/** Server specs for the widgets the client declared (latest frontend-tool version of each). */
export function selectWidgetSpecs(
  index: WidgetSpecIndex,
  declared: ReadonlyArray<{ name?: unknown }> | undefined,
): WidgetSpec[] {
  const offered = new Map(index.frontendSpecs().map((s) => [s.name, s]));
  const out = new Map<string, WidgetSpec>();
  for (const tool of (declared ?? []).slice(0, MAX_DECLARED_TOOLS)) {
    const name = typeof tool?.name === 'string' ? tool.name : undefined;
    const spec = name ? offered.get(name) : undefined;
    if (spec) out.set(spec.name, spec);
  }
  return [...out.values()];
}

/** The spec of a widget tool call parked in the session, or undefined when it is not a widget. */
export function suspendedWidgetSpec(
  index: WidgetSpecIndex,
  session: { suspensions?: { get(args: { toolCallId: string }): { toolName: string } | undefined } },
  toolCallId: string,
): WidgetSpec | undefined {
  const suspension = session.suspensions?.get({ toolCallId });
  if (!suspension) return undefined;
  const spec = index.latest(suspension.toolName);
  return spec?.frontendTool ? spec : undefined;
}

/** AG-UI resume payload for a widget answer: only `answer` (unknown fields are refused). */
const widgetResumePayloadSchema = z.strictObject({ answer: z.unknown() });

export type WidgetResumeDecision =
  | { ok: true; resume: WidgetResume }
  | { ok: false; issues: string[] };

/** Turns one AG-UI resume entry for a suspended widget into validated resume data. */
export function widgetResumeFromEntry(
  spec: WidgetSpec,
  entry: { toolCallId: string; status: string; payload?: unknown },
  now: Date = new Date(),
): WidgetResumeDecision {
  if (entry.status === 'cancelled') {
    return entry.payload === undefined || entry.payload === null
      ? { ok: true, resume: { kind: 'dismissed', toolCallId: entry.toolCallId } }
      : { ok: false, issues: ['payload: a dismissal carries no payload'] };
  }
  if (entry.status !== 'resolved') return { ok: false, issues: ['status: unsupported'] };
  const payload = widgetResumePayloadSchema.safeParse(entry.payload);
  if (!payload.success || !('answer' in (entry.payload as object))) {
    return { ok: false, issues: ['payload: must be { answer } with no other fields'] };
  }
  const accepted = acceptWidgetAnswer(spec, entry.toolCallId, payload.data.answer, now);
  if (!accepted.ok) return { ok: false, issues: accepted.issues.map((i) => `answer.${i}`) };
  return { ok: true, resume: { kind: 'answer', record: accepted.record } };
}

export interface StoredWidgetAnswer {
  toolCallId: string;
  widget: string;
  version: number;
  answer: unknown;
  /** When the tool result was stored. */
  answeredAt?: string;
}

interface StoredMessage {
  createdAt?: unknown;
  content?: unknown;
}

/**
 * Widget answers stored in a thread: tool results of known widget tools whose content is a widget
 * answer (dismissals and errors are skipped). Reads Mastra v2 message parts (`tool-invocation`).
 */
export function widgetAnswersFromMessages(index: WidgetSpecIndex, messages: readonly StoredMessage[]): StoredWidgetAnswer[] {
  const out: StoredWidgetAnswer[] = [];
  for (const message of messages) {
    const parts = (message.content as { parts?: unknown } | undefined)?.parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      const inv = (part as { type?: unknown; toolInvocation?: Record<string, unknown> }).toolInvocation;
      if ((part as { type?: unknown }).type !== 'tool-invocation' || !inv || inv.state !== 'result') continue;
      const toolCallId = typeof inv.toolCallId === 'string' ? inv.toolCallId : undefined;
      const toolName = typeof inv.toolName === 'string' ? inv.toolName : undefined;
      if (!toolCallId || !toolName || !index.has(toolName)) continue;
      const stored = parseStoredWidgetAnswer(toolCallId, toolName, inv.result);
      if (!stored) continue;
      const created = message.createdAt instanceof Date ? message.createdAt.toISOString() : typeof message.createdAt === 'string' ? message.createdAt : undefined;
      out.push({ ...stored, ...(created ? { answeredAt: created } : {}) });
    }
  }
  return out;
}

/** Widget answers stored in a thread (via the session's thread API). */
export async function listWidgetAnswers(
  index: WidgetSpecIndex,
  session: { thread: { listMessages(args: { threadId: string }): Promise<unknown> } },
  threadId: string,
): Promise<StoredWidgetAnswer[]> {
  const result = await session.thread.listMessages({ threadId });
  const messages = Array.isArray(result) ? result : ((result as { messages?: unknown[] })?.messages ?? []);
  return widgetAnswersFromMessages(index, messages as StoredMessage[]);
}
