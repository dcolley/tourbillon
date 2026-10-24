/**
 * WID-2: which chat tool calls show the approval card. A finished `createApproval` call (the
 * agent asked the Board) or `getApproval` call (the agent looked one up) whose result names an
 * approval is rendered as the `approvalCard` widget for that approval id; anything else keeps its
 * own rendering (fallback card). Only the id is taken from the result: the card reads the rest
 * from the Board-only card route.
 */
import { approvalCardSpec } from './specs';

/** Tool names as the agent runtime may report them (toolset key or tool id). */
export const APPROVAL_CARD_SOURCE_TOOLS: ReadonlySet<string> = new Set([
  'createApproval',
  'createApprovalTool',
  'getApproval',
  'getApprovalTool',
]);

const ID = /^[A-Za-z0-9_-]{1,128}$/;

export interface ChatToolCallLike {
  id: string;
  name: string;
  status: string;
  result?: string;
}

function approvalIdIn(result: string | undefined): string | null {
  if (!result) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if ('error' in obj && obj.error) return null;
  // createApproval returns the approval; getApproval may wrap it as { approval }.
  const inner = obj.approval && typeof obj.approval === 'object' ? (obj.approval as Record<string, unknown>) : obj;
  const id = inner.id;
  return typeof id === 'string' && ID.test(id) ? id : null;
}

/** The approval card call for this tool item, or null to render the tool call as it is. */
export function approvalCardCallFor(item: ChatToolCallLike): { toolCallId: string; toolName: string; args: { approvalId: string } } | null {
  if (item.status !== 'done' || !APPROVAL_CARD_SOURCE_TOOLS.has(item.name)) return null;
  const approvalId = approvalIdIn(item.result);
  if (!approvalId) return null;
  return { toolCallId: item.id, toolName: approvalCardSpec.name, args: { approvalId } };
}
