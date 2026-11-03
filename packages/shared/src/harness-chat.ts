/**
 * #281 AC5 — harness chat over the callback (Soft Pack E · S316-S3 / S322-S5).
 *
 * A bound harness ADVERTISES chat in its bind (`adapterConfig.chat = { sync?, stream? }`,
 * jsonb — no migration). Nothing advertised ⇒ chat is refused (fail closed). The wire shape
 * is the A2A JSONRPC surface the Hermes gateway already speaks (measured 2026-11-02: JSONRPC
 * binding, `capabilities.streaming: true`):
 *
 *   POST {callback.baseUrl}/api/harness/callback/chat
 *   Authorization: Bearer <callback.sessionToken>
 *   { "jsonrpc": "2.0", "id": "…", "method": "message/send" | "message/stream",
 *     "params": { "message": { "role": "user", "parts": [{ "kind": "text", "text": "…" }],
 *       "metadata": { "tourbillon": { "toAgentUrlKey": "cto" } } } } }
 *
 *  - `message/send`   (sync)   needs `chat.sync`   → JSON-RPC result = A2A agent Message.
 *  - `message/stream` (stream) needs `chat.stream` → `text/event-stream` of JSON-RPC
 *    responses (TaskStatusUpdateEvent working → Message → TaskStatusUpdateEvent final).
 *
 * Chat does NOT add a second chat stack: delivery runs the agent's own capability-gated DM tool
 * (`sendToAgent`, from `assembleAgentTools`) — denied ⇒ 403 and never executed. Board chat
 * stays the in-product Tourbillon chat surface; a harness reaches the Board through issue
 * comments / approvals as before.
 */
import { z } from 'zod';

/** Bind field: what chat legs the harness advertises. Strict — a typo must not enable chat. */
export const harnessChatCapabilitySchema = z
  .object({
    /** A2A `message/send` (or the harness's equivalent sync prompt). */
    sync: z.boolean().optional(),
    /** A2A `message/stream` (SSE). Only when the harness really streams (Hermes agent card). */
    stream: z.boolean().optional(),
  })
  .strict();

export type HarnessChatCapability = z.infer<typeof harnessChatCapabilitySchema>;

export type HarnessChatMode = 'sync' | 'stream';

/** JSON-RPC method → chat leg. Anything else is refused. */
export const HARNESS_CHAT_METHODS = {
  'message/send': 'sync',
  'message/stream': 'stream',
} as const satisfies Record<string, HarnessChatMode>;

export function harnessChatModeForMethod(method: string): HarnessChatMode | null {
  return Object.prototype.hasOwnProperty.call(HARNESS_CHAT_METHODS, method)
    ? HARNESS_CHAT_METHODS[method as keyof typeof HARNESS_CHAT_METHODS]
    : null;
}

/** Max chat text accepted (DMs are meant to be short; this only bounds abuse). */
export const HARNESS_CHAT_MAX_TEXT = 8000;

const chatPartSchema = z
  .object({
    kind: z.string().min(1),
    text: z.string().optional(),
  })
  .passthrough();

export const harnessChatRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string().min(1).max(200), z.number().int()]),
  method: z.string().min(1).max(100),
  params: z.object({
    message: z
      .object({
        kind: z.literal('message').optional(),
        role: z.enum(['user', 'agent']).optional(),
        messageId: z.string().min(1).max(200).optional(),
        parts: z.array(chatPartSchema).min(1).max(50),
        metadata: z
          .object({
            tourbillon: z
              .object({
                toAgentId: z.string().min(1).max(200).optional(),
                toAgentUrlKey: z.string().min(1).max(200).optional(),
                inReplyTo: z.string().min(1).max(200).optional(),
              })
              .strict()
              .optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough(),
  }),
});

export type HarnessChatRequest = z.infer<typeof harnessChatRequestSchema>;

/** Concatenate the text parts (non-text parts are ignored — DMs are text). */
export function harnessChatText(parts: HarnessChatRequest['params']['message']['parts']): string {
  return parts
    .filter((p) => p.kind === 'text' && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('\n')
    .trim();
}

export interface A2aAgentMessage {
  kind: 'message';
  role: 'agent';
  messageId: string;
  contextId: string;
  parts: Array<{ kind: 'text'; text: string } | { kind: 'data'; data: unknown }>;
}

export function buildHarnessChatReply(input: {
  messageId: string;
  contextId: string;
  text: string;
  data: unknown;
}): A2aAgentMessage {
  return {
    kind: 'message',
    role: 'agent',
    messageId: input.messageId,
    contextId: input.contextId,
    parts: [
      { kind: 'text', text: input.text },
      { kind: 'data', data: input.data },
    ],
  };
}

export interface A2aStatusUpdate {
  kind: 'status-update';
  taskId: string;
  contextId: string;
  status: { state: 'working' | 'completed' | 'failed'; message?: A2aAgentMessage };
  final: boolean;
}

/** One SSE frame per JSON-RPC response (A2A `message/stream` framing). */
export function encodeHarnessChatSse(id: string | number, results: unknown[]): string {
  return results.map((result) => `data: ${JSON.stringify({ jsonrpc: '2.0', id, result })}\n\n`).join('');
}
