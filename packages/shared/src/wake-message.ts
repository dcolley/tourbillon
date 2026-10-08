import type { HeartbeatJobData, WakePayload } from './types';
import {
  WAKE_COMMENTS_T1_MAX_CHARS,
  WAKE_CONTEXT_VERSION,
} from './wake-context/constants';
import { extractApprovalTokens, extractIssueIdentifiers, type ApprovalClaimState } from './wake-context/annotate';
import {
  renderCommentSectionT1,
  renderCommentSectionV2,
  type CommentSectionResult,
} from './wake-context/comments';
import { renderLiveStateHeader } from './wake-context/header';
import { asText, flattenInline, neutraliseSystemMarkers, sanitizeWakeComments } from './wake-context/sanitize';
import { DEFAULT_WAKE_CONTEXT_BUDGETS } from './wake-context/settings';
import type {
  WakeContextBudgets,
  WakeContextStats,
  WakeLiveContext,
  WakeRenderFallback,
} from './wake-context/types';

export interface BuildWakeMessageOptions {
  /** Live DB state from the scheduler's buildWakeContext. Absent/null → T1-only message. */
  context?: WakeLiveContext | null;
  budgets?: Partial<WakeContextBudgets>;
}

const COMPRESSED_HINT =
  '\nThis is a compressed view. After checkout, call getComments without `after` for the full thread.';
const FALLBACK_HINT =
  '\nFull comment history may be incomplete in this wake message. ' +
  'After checkout, call getComments without `after` for the full thread.';
const HEARTBEAT_LINE = '\nBegin your heartbeat procedure. Follow SKILL: Control Plane Operations exactly.';
/** S4: linked issue ids listed in the v2 lead (the lead counts against the total budget). */
export const WAKE_V2_LEAD_MAX_LINKED_IDS = 10;

/** Parsed payload with every field the renderers read made safe (B1). */
interface SafePayload {
  issue: { identifier: string; title: string; status: string; priority: string } | null;
  newComments: ReturnType<typeof sanitizeWakeComments>;
  fallbackFetchNeeded: boolean;
}

/**
 * B1: malformed JSON → null; otherwise newComments is always a clean array (non-array → [], null
 * or non-object entries dropped, fields coerced to strings) and issue is an object or null.
 */
function parsePayload(json: string | undefined): SafePayload | null {
  if (!json || typeof json !== 'string') return null;
  let p: unknown;
  try {
    p = JSON.parse(json);
  } catch {
    return null; /* ignore malformed payload */
  }
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  const raw = p as Partial<Record<keyof WakePayload, unknown>>;
  const issueRaw = raw.issue;
  const issue =
    issueRaw && typeof issueRaw === 'object' && !Array.isArray(issueRaw)
      ? (() => {
          const i = issueRaw as Record<string, unknown>;
          return {
            identifier: asText(i.identifier),
            title: asText(i.title),
            status: asText(i.status),
            priority: asText(i.priority),
          };
        })()
      : null;
  return {
    issue,
    newComments: sanitizeWakeComments(raw.newComments),
    fallbackFetchNeeded: raw.fallbackFetchNeeded === true,
  };
}

function leadParts(data: HeartbeatJobData, opts: { maxLinkedIds?: number } = {}): string[] {
  const parts = [`Wake reason: ${data.wakeReason}`];
  if (data.taskId) parts.push(`Assigned task ID: ${data.taskId}`);
  if (data.wakeReason === 'approval_resolved') {
    if (data.approvalId) parts.push(`Approval ID: ${data.approvalId}`);
    if (data.approvalStatus) parts.push(`Board decision: ${data.approvalStatus}`);
    const noteText = asText(data.approvalNote).trim();
    if (noteText) {
      parts.push(`Board note: ${noteText.length > 500 ? `${noteText.slice(0, 500)}…` : noteText}`);
    }
    const linked = Array.isArray(data.linkedIssueIds) ? data.linkedIssueIds.map(asText).filter(Boolean) : [];
    if (linked.length) {
      const max = opts.maxLinkedIds ?? linked.length;
      const head = linked.slice(0, max);
      const more = linked.length - head.length;
      parts.push(`Linked issue IDs: ${head.join(', ')}${more > 0 ? `, +${more} more` : ''}`);
    }
  }
  if (data.wakeReason === 'agent_mail') {
    if (data.mailId) parts.push(`Mail ID: ${data.mailId}`);
    if (data.mailFromAgentId) parts.push(`From agent ID: ${data.mailFromAgentId}`);
    if (data.mailFromAgentName) parts.push(`From: ${data.mailFromAgentName}`);
    const body = asText(data.mailBody).trim();
    if (body) parts.push(`Message: ${body}`);
  }
  return parts;
}

function emptyStats(mode: WakeContextStats['mode']): WakeContextStats {
  return {
    version: WAKE_CONTEXT_VERSION,
    mode,
    headerChars: 0,
    commentChars: 0,
    totalChars: 0,
    considered: 0,
    shown: 0,
    hidden: 0,
    dropped: 0,
    deduped: 0,
    condensed: 0,
    annotated: 0,
    approvalsListed: [],
  };
}

function withSectionStats(stats: WakeContextStats, s: CommentSectionResult): WakeContextStats {
  return {
    ...stats,
    commentChars: s.text.length,
    considered: s.considered,
    shown: s.shown,
    hidden: s.hidden,
    dropped: s.dropped,
    deduped: s.deduped,
    condensed: s.condensed,
    annotated: s.annotated,
  };
}

/** T1 only: today's layout with the newest-first fill (WC1). */
function buildT1(data: HeartbeatJobData, budgets: WakeContextBudgets): { message: string; stats: WakeContextStats } {
  const parts = leadParts(data);
  let stats = emptyStats('t1');
  const payload = parsePayload(data.wakePayloadJson);
  if (payload) {
    if (payload.issue) {
      // S1: one line (a title can't start a fake block in this header-less layout).
      const one = (v: string) => neutraliseSystemMarkers(flattenInline(v));
      parts.push(
        `Task: ${one(payload.issue.identifier)} — ${one(payload.issue.title)} (${one(payload.issue.status)}, ${one(payload.issue.priority)})`,
      );
    }
    let section: CommentSectionResult | null = null;
    if (payload.newComments?.length) {
      section = renderCommentSectionT1(payload.newComments, {
        budget: Math.min(WAKE_COMMENTS_T1_MAX_CHARS, budgets.commentsMaxChars),
      });
      parts.push(`\n${section.text}`);
      stats = withSectionStats(stats, section);
    }
    if (payload.fallbackFetchNeeded || (section && section.dropped > 0)) parts.push(FALLBACK_HINT);
  }
  if (data.wakeReason !== 'agent_mail') parts.push(HEARTBEAT_LINE);
  const message = parts.join('\n');
  return { message, stats: { ...stats, totalChars: message.length } };
}

/** WC1–6: live-state header + compacted, annotated, newest-first comments. */
function buildV2(
  data: HeartbeatJobData,
  ctx: WakeLiveContext,
  budgets: WakeContextBudgets,
): { message: string; stats: WakeContextStats } {
  // S4: the lead is bounded (linked ids capped) and counted in fixedChars below.
  const lead = leadParts(data, { maxLinkedIds: WAKE_V2_LEAD_MAX_LINKED_IDS });
  const payload = parsePayload(data.wakePayloadJson);
  const comments = payload?.newComments ?? [];
  const approvalMap = new Map<string, ApprovalClaimState>();
  for (const a of ctx.approvals) {
    const s = a.id.slice(0, 8);
    if (!approvalMap.has(s)) approvalMap.set(s, { status: a.status, decidedAt: a.decidedAt });
  }

  const cites = (bodies: string[]) => {
    const approvals = new Set<string>();
    const identifiers: string[] = [];
    // Newest first so the most recent references lead the "Other issues" line.
    for (const body of [...bodies].reverse()) {
      for (const t of extractApprovalTokens(body)) approvals.add(t);
      for (const id of extractIssueIdentifiers(body)) if (!identifiers.includes(id)) identifiers.push(id);
    }
    return { approvals, identifiers };
  };

  // Header sized against every candidate first, so the comment budget leaves it room.
  const allCites = cites(comments.map((c) => c.body));
  const prelim = renderLiveStateHeader(ctx, {
    citedApprovalIds: allCites.approvals,
    citedIdentifiers: allCites.identifiers,
    maxChars: budgets.headerMaxChars,
  });
  const tail = [COMPRESSED_HINT, ...(data.wakeReason !== 'agent_mail' ? [HEARTBEAT_LINE] : [])];
  const fixedChars = [...lead, '', '', '', '', ...tail].join('\n').length;

  const sectionFor = (budget: number) =>
    renderCommentSectionV2(comments, {
      budget,
      agentName: ctx.agent.name,
      agentUrlKey: ctx.agent.urlKey,
      approvals: approvalMap,
      refIso: ctx.asOf,
    });

  const assemble = (headerText: string, section: CommentSectionResult) =>
    [
      ...lead,
      '',
      headerText,
      '',
      section.text || 'RECENT COMMENTS: none in this wake.',
      ...tail,
    ].join('\n');

  let commentBudget = Math.max(
    0,
    Math.min(budgets.commentsMaxChars, budgets.totalSoftMaxChars - prelim.text.length - fixedChars),
  );
  let section = sectionFor(commentBudget);
  let shownCites = cites(section.shownBodies);
  let header = renderLiveStateHeader(ctx, {
    citedApprovalIds: shownCites.approvals,
    citedIdentifiers: shownCites.identifiers,
    maxChars: budgets.headerMaxChars,
  });
  let message = assemble(header.text, section);
  if (message.length > budgets.totalSoftMaxChars && section.text) {
    // One deterministic re-fit if the final header came out longer than the estimate.
    commentBudget = Math.max(0, commentBudget - (message.length - budgets.totalSoftMaxChars));
    section = sectionFor(commentBudget);
    shownCites = cites(section.shownBodies);
    header = renderLiveStateHeader(ctx, {
      citedApprovalIds: shownCites.approvals,
      citedIdentifiers: shownCites.identifiers,
      maxChars: budgets.headerMaxChars,
    });
    message = assemble(header.text, section);
  }

  const stats: WakeContextStats = {
    ...withSectionStats(emptyStats('v2'), section),
    headerChars: header.text.length,
    totalChars: message.length,
    approvalsListed: header.approvalsListed,
  };
  return { message, stats };
}

const MINIMAL_FALLBACK_MESSAGE = `Wake reason: unknown\n${HEARTBEAT_LINE}`;

/** Last resort (B1): wake reason, task id and the heartbeat line; reads nothing else. */
function buildMinimal(data: HeartbeatJobData): { message: string; stats: WakeContextStats } {
  let message: string;
  try {
    const reason = flattenInline(asText(data?.wakeReason)) || 'unknown';
    const taskId = flattenInline(asText(data?.taskId));
    const parts = [`Wake reason: ${reason}`];
    if (taskId) parts.push(`Assigned task ID: ${taskId}`);
    parts.push('\nThe wake details could not be rendered. After checkout, call getComments for the thread.');
    if (reason !== 'agent_mail') parts.push(HEARTBEAT_LINE);
    message = parts.join('\n');
  } catch {
    message = MINIMAL_FALLBACK_MESSAGE;
  }
  return { message, stats: { ...emptyStats('minimal'), totalChars: message.length, fallback: 't1_render_failed' } };
}

/**
 * Wake message plus the counts recorded as contextSnapshot.wakeContext. Pure and deterministic:
 * the same job data, context and budgets always give the same output.
 *
 * Never throws (#122 follow-up B1): v2 failure → T1 layout (stats.fallback 'v2_render_failed');
 * T1 failure → minimal message (mode 'minimal', stats.fallback 't1_render_failed').
 */
export function buildWakeMessageWithStats(
  data: HeartbeatJobData,
  opts: BuildWakeMessageOptions = {},
): { message: string; stats: WakeContextStats } {
  let fallback: WakeRenderFallback | undefined;
  try {
    const budgets: WakeContextBudgets = { ...DEFAULT_WAKE_CONTEXT_BUDGETS, ...(opts?.budgets ?? {}) };
    if (opts?.context && data.taskId && data.wakeReason !== 'agent_mail') {
      try {
        return buildV2(data, opts.context, budgets);
      } catch {
        fallback = 'v2_render_failed';
      }
    }
    const t1 = buildT1(data, budgets);
    return fallback ? { message: t1.message, stats: { ...t1.stats, fallback } } : t1;
  } catch {
    return buildMinimal(data);
  }
}

export function buildWakeMessage(data: HeartbeatJobData, opts: BuildWakeMessageOptions = {}): string {
  return buildWakeMessageWithStats(data, opts).message;
}
