/**
 * WID-1: the assistant's widget specs (no components), shared by the AG-UI route (server) and the
 * client registry. The route only offers a widget tool to a run when the client declares it in
 * `RunAgentInput.tools` and it is listed here, and it validates answers against these schemas, never
 * against schemas sent by the client.
 *
 * Add the spec here and the `{ ...spec, component }` definition to `assistantWidgetRegistry`
 * together (a registry test checks the two lists match).
 */
import { z } from 'zod';
import { createWidgetSpecIndex, type WidgetSpec } from '@tourbillon/shared/widgets';

/**
 * WID-2: the Board approval card. Props are only the approval id; the card reads the approval
 * from `GET /api/approvals/:id/card` (Board, active company) and answers through the Board decide
 * route, so the chat holds no copy of the question and no token.
 *
 * Not a frontend tool (never offered to the model, never suspends a run): the chat shows it for a
 * finished `createApproval` / `getApproval` tool call (approval-card-binding). The agent gets the
 * Board's answer as it does today, through the approval wake.
 */
export const approvalCardSpec: WidgetSpec<{ approvalId: string }> = {
  name: 'approvalCard',
  version: 1,
  description: 'Board approval card: shows one approval and lets the Board answer it in the chat.',
  propsSchema: z.strictObject({
    approvalId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  }),
  frontendTool: false,
};

export const assistantWidgetSpecs: readonly WidgetSpec[] = [approvalCardSpec];

export const assistantWidgetSpecIndex = createWidgetSpecIndex(assistantWidgetSpecs);
