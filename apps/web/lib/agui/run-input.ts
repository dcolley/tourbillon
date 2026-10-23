/**
 * AGUI-1: validates an AG-UI RunAgentInput and the Tourbillon options carried in
 * `forwardedProps.tourbillon`.
 */
import { RunAgentInputSchema } from '@ag-ui/core/schemas';
import type { RunAgentInput } from '@ag-ui/core';
import { z } from 'zod';
import { chatDashboardContextSchema, type ChatDashboardContext } from '@/lib/chat/dashboard-context';

/** Ids used as Mastra thread ids / session scopes: bounded, no whitespace or path characters. */
const idSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/);

export const aguiActionSchema = z.enum(['run', 'steer', 'followUp', 'abort', 'toolApproval']);
export type AguiAction = z.infer<typeof aguiActionSchema>;

export const tourbillonPropsSchema = z
  .object({
    action: aguiActionSchema.optional(),
    resourceId: z.string().min(1).max(300).optional(),
    sessionScope: idSchema.optional(),
    context: chatDashboardContextSchema,
    toolCallId: z.string().min(1).max(200).optional(),
    approved: z.boolean().optional(),
  })
  .strict();

export type TourbillonAguiProps = z.infer<typeof tourbillonPropsSchema>;

export interface AguiFile {
  data: string;
  mediaType: string;
  filename?: string;
}

export interface AguiToolDecision {
  toolCallId: string;
  approved: boolean;
}

export interface ParsedAguiRequest {
  input: RunAgentInput;
  action: AguiAction;
  props: TourbillonAguiProps;
  /** Text of the last user message ('' when there is none). */
  message: string;
  files: AguiFile[];
  context: ChatDashboardContext;
  /** From `forwardedProps.tourbillon` (toolApproval) or AG-UI `resume` entries. */
  toolDecisions: AguiToolDecision[];
}

export class AguiInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AguiInputError';
  }
}

const MAX_FILES = 20;

function lastUserMessage(input: RunAgentInput): { message: string; files: AguiFile[] } {
  for (let i = input.messages.length - 1; i >= 0; i--) {
    const m = input.messages[i];
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return { message: m.content, files: [] };
    const texts: string[] = [];
    const files: AguiFile[] = [];
    for (const part of m.content) {
      if (part.type === 'text') {
        texts.push(part.text);
        continue;
      }
      const source = (part as { source?: { type?: string; value?: unknown; mimeType?: unknown } }).source;
      if (source?.type === 'data' && typeof source.value === 'string' && typeof source.mimeType === 'string') {
        const filename = (part as { metadata?: { filename?: unknown } }).metadata?.filename;
        files.push({
          data: source.value,
          mediaType: source.mimeType,
          ...(typeof filename === 'string' ? { filename } : {}),
        });
        continue;
      }
      throw new AguiInputError(`Unsupported user content part: ${part.type}`);
    }
    if (files.length > MAX_FILES) throw new AguiInputError(`At most ${MAX_FILES} files per message`);
    return { message: texts.join('\n'), files };
  }
  return { message: '', files: [] };
}

export function parseAguiRequest(body: unknown): ParsedAguiRequest {
  const parsed = RunAgentInputSchema.safeParse(body);
  if (!parsed.success) throw new AguiInputError('Invalid AG-UI RunAgentInput');
  const input = parsed.data as RunAgentInput;
  if (!idSchema.safeParse(input.threadId).success) throw new AguiInputError('Invalid threadId');

  const forwarded = input.forwardedProps as { tourbillon?: unknown } | undefined;
  const propsResult = tourbillonPropsSchema.safeParse(forwarded?.tourbillon ?? {});
  if (!propsResult.success) throw new AguiInputError('Invalid forwardedProps.tourbillon');
  const props = propsResult.data;

  const toolDecisions: AguiToolDecision[] = [];
  for (const entry of input.resume ?? []) {
    const payload = entry.payload as { approved?: unknown } | undefined;
    toolDecisions.push({
      toolCallId: entry.interruptId,
      approved: entry.status === 'resolved' && payload?.approved !== false,
    });
  }
  if (props.action === 'toolApproval') {
    if (!props.toolCallId || props.approved === undefined) {
      throw new AguiInputError('toolApproval needs toolCallId and approved');
    }
    toolDecisions.push({ toolCallId: props.toolCallId, approved: props.approved });
  }

  const action: AguiAction = props.action ?? (toolDecisions.length > 0 ? 'toolApproval' : 'run');
  const { message, files } = lastUserMessage(input);
  if ((action === 'run' || action === 'steer' || action === 'followUp') && !message.trim()) {
    throw new AguiInputError('The last message must be a non-empty user message');
  }

  return { input, action, props, message, files, context: props.context, toolDecisions };
}
