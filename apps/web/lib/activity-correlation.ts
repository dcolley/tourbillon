/**
 * ACT-1: helpers for activity writers. No database import, so every writer (and its tests) can use
 * them without loading the read side.
 */
import { randomUUID } from 'node:crypto';

/** One id per action; every activity row that action writes carries it (`activity_log.correlation_id`). */
export function newActivityCorrelationId(): string {
  return randomUUID();
}

/** Short title of an approval for activity text (never the payload as a whole). */
export function approvalTitleOf(row: { type: string; payload?: unknown; hitlRequest?: unknown }): string {
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  const question = (row.hitlRequest as { question?: unknown } | null | undefined)?.question;
  if (typeof payload.title === 'string' && payload.title.trim()) return payload.title.trim();
  if (typeof question === 'string' && question.trim()) return question.trim();
  return row.type.replace(/_/g, ' ');
}

type ChangeMap = Record<string, { from: unknown; to: unknown }>;

/**
 * `{ field: { from, to } }` for the fields in `next` that differ from `prev`. Used in
 * `details.changes` so the Activity view can say "Status todo → in progress".
 */
export function changesBetween(prev: Record<string, unknown>, next: Record<string, unknown>, fields: readonly string[]): ChangeMap {
  const out: ChangeMap = {};
  for (const field of fields) {
    if (!(field in next)) continue;
    const from = prev[field] ?? null;
    const to = next[field] ?? null;
    if (from !== to) out[field] = { from, to };
  }
  return out;
}

/** Fields whose before/after the issue, goal and project writers record. */
export const TRACKED_CHANGE_FIELDS = [
  'title',
  'status',
  'priority',
  'description',
  'assigneeAgentId',
  'assigneeUserId',
  'ownerAgentId',
  'goalId',
  'projectId',
  'parentId',
  'boardApprovalId',
] as const;
