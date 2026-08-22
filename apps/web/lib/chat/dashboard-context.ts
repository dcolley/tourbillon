import { z } from 'zod';

/** Optional page context sent with chat messages so the model knows "this issue". */
export const chatDashboardContextSchema = z
  .object({
    contextType: z.enum(['free', 'issue', 'project', 'goal', 'heartbeat', 'agent', 'board']),
    contextId: z.string().min(1).optional(),
    contextTitle: z.string().optional(),
  })
  .optional();

export type ChatDashboardContext = z.infer<typeof chatDashboardContextSchema>;

const CONTEXT_BLOCK_RE =
  /^\[Dashboard context\]\n[\s\S]*?\n\[\/Dashboard context\](?:\n+|$)/;

export function stripDashboardContext(text: string): string {
  return text.replace(CONTEXT_BLOCK_RE, '').trimStart();
}

/**
 * Wrap a human chat message with dashboard page context the model can use
 * (e.g. issue id when the operator says "this issue").
 */
export function wrapMessageWithDashboardContext(
  message: string,
  context?: ChatDashboardContext | null,
): string {
  const trimmed = message.trim();
  if (!context || context.contextType === 'free' || !context.contextId) {
    return trimmed;
  }

  const title = context.contextTitle?.trim();
  const titleBit = title ? ` "${title}"` : '';
  const lines = [
    '[Dashboard context]',
    `The human is viewing ${context.contextType} \`${context.contextId}\`${titleBit} in the Tourbillon dashboard.`,
    `When they say "this ${context.contextType}", "the ${context.contextType}", or similar, they mean that ${context.contextType}.`,
    `Use tools with id \`${context.contextId}\` (e.g. getComments for an issue) rather than asking them to paste the id.`,
    '[/Dashboard context]',
    '',
    trimmed,
  ];
  return lines.join('\n');
}
