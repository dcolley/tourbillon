/**
 * ACT-1: turn raw activity_log rows into what the Activity views show: the item with a human name
 * and a link, who did it (and through what), the change in words, a comment excerpt, the approval
 * decision, and the correlation group. Pure: no database access. `lib/activity.ts` loads the
 * company-scoped lookup this module reads from.
 *
 * Company scoping: every name and link comes from the lookup, which only ever holds rows of the
 * activity row's own company. An id the lookup does not hold (deleted, or not in this company)
 * renders as "Unknown <kind>" with no link and no name.
 */
import type { ActivityLogEntry } from '@tourbillon/db';

export type ActivityItemKind = 'issue' | 'agent' | 'run' | 'approval' | 'project' | 'goal';

export const ACTIVITY_ITEM_KINDS: readonly ActivityItemKind[] = ['issue', 'agent', 'run', 'approval', 'project', 'goal'];

/** Entity types the item-type filter offers (activity_log.entity_type values). */
export const ACTIVITY_ENTITY_TYPES = [
  'issue',
  'approval',
  'agent',
  'project',
  'goal',
  'workspace',
  'llm_provider',
] as const;
export type ActivityEntityType = (typeof ACTIVITY_ENTITY_TYPES)[number];

export const COMMENT_EXCERPT_CHARS = 140;

export interface ActivityLookup {
  issues: Map<string, { identifier: string; title: string }>;
  agents: Map<string, { name: string; urlKey: string }>;
  runs: Map<string, { agentId: string }>;
  approvals: Map<string, { title: string; status: string }>;
  projects: Map<string, { title: string }>;
  goals: Map<string, { title: string }>;
}

export function emptyActivityLookup(): ActivityLookup {
  return {
    issues: new Map(),
    agents: new Map(),
    runs: new Map(),
    approvals: new Map(),
    projects: new Map(),
    goals: new Map(),
  };
}

export interface ActivityLink {
  kind: ActivityItemKind;
  id: string;
  /** Human label; never a bare id (runs show a short id, as their name). */
  label: string;
  /** Null when the item is not in this company's lookup. */
  href: string | null;
}

export interface ActivityActorView {
  type: ActivityLogEntry['actorType'];
  id: string;
  /** e.g. "Agent CEO", "Board", "System". */
  label: string;
  href: string | null;
  /** The run the agent acted in, when recorded. */
  run: ActivityLink | null;
  /** System rows written because of an approval decision. */
  viaApproval: ActivityLink | null;
  /** Who decided that approval ("Board", "HITLy", "MCP", "Deadline"), when known. */
  viaDecider: string | null;
  /** Approval outcome word for the "via" line ("approved", "rejected", ...). */
  viaOutcome: string | null;
}

export type ActivityChangeValue = { text: string } | { link: ActivityLink };

export interface ActivityChange {
  field: string;
  label: string;
  from: ActivityChangeValue | null;
  to: ActivityChangeValue;
}

export interface ActivityComment {
  excerpt: string;
  full: string;
  truncated: boolean;
}

export interface ActivityDecision {
  outcome: string;
  reason: string | null;
  answer: string | null;
}

export interface ActivityView {
  id: string;
  createdAt: Date;
  action: string;
  actionLabel: string;
  entityType: string;
  entityId: string;
  item: ActivityLink | null;
  actor: ActivityActorView;
  changes: ActivityChange[];
  comment: ActivityComment | null;
  decision: ActivityDecision | null;
  /** Other items the row points at (linked issues of an approval, blockers, ...). */
  related: ActivityLink[];
  correlationId: string | null;
  details: Record<string, unknown>;
}

const ACTION_LABELS: Record<string, string> = {
  'issue.checked_out': 'Issue checked out',
  'issue.updated': 'Issue updated',
  'issue.created': 'Issue created',
  'issue.commented': 'Comment added',
  'issue.lock_released': 'Checkout lock released',
  'issue.wake_skipped': 'Wake skipped',
  'issue.wake_failed': 'Wake failed',
  'agent.created': 'Agent hired',
  'agent.code_execution_updated': 'Agent code & execution updated',
  'approval.created': 'Approval requested',
  'approval.decided': 'Approval decided',
  'approval.forwarded': 'Approval sent to HITLy',
  'approval.forward_failed': 'Approval could not be sent to HITLy',
  'goal.created': 'Goal created',
  'goal.updated': 'Goal updated',
  'project.created': 'Project created',
  'project.updated': 'Project updated',
  'project.auto_paused': 'Project paused (goal archived)',
  'project.auto_resumed': 'Project resumed (goal reactivated)',
  'workspace.file_write': 'Workspace file written',
};

export function formatActivityAction(action: string): string {
  return ACTION_LABELS[action] ?? action.replace(/\./g, ' · ').replace(/_/g, ' ');
}

/** Detail keys that hold an id, and what kind of item it points at. */
const ID_FIELDS: Record<string, ActivityItemKind> = {
  assigneeAgentId: 'agent',
  ownerAgentId: 'agent',
  goalId: 'goal',
  projectId: 'project',
  parentId: 'issue',
  boardApprovalId: 'approval',
  approvalId: 'approval',
  checkoutRunId: 'run',
  runId: 'run',
  previousCheckoutRunId: 'run',
  replacedStaleLockFrom: 'run',
};

/** Fields shown as "field from → to". Everything else stays in Raw details. */
const CHANGE_FIELDS: Record<string, string> = {
  title: 'Title',
  status: 'Status',
  priority: 'Priority',
  description: 'Description',
  assigneeAgentId: 'Assignee',
  assigneeUserId: 'Assigned to Board',
  ownerAgentId: 'Owner',
  goalId: 'Goal',
  projectId: 'Project',
  parentId: 'Parent issue',
  boardApprovalId: 'Board approval',
  enabled: 'Enabled',
};

/** Actions whose details are a set of changed fields (legacy rows, written before ACT-1). */
const LEGACY_CHANGE_ACTIONS = new Set(['issue.updated', 'goal.updated', 'project.updated']);

const ENTITY_KIND: Record<string, ActivityItemKind> = {
  issue: 'issue',
  agent: 'agent',
  approval: 'approval',
  project: 'project',
  goal: 'goal',
  heartbeat_run: 'run',
};

function asRecord(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

export function hrefFor(kind: ActivityItemKind, id: string, lookup: ActivityLookup): string | null {
  switch (kind) {
    case 'issue':
      return lookup.issues.has(id) ? `/issue/${encodeURIComponent(id)}` : null;
    case 'agent': {
      const agent = lookup.agents.get(id);
      return agent ? `/agent/${encodeURIComponent(agent.urlKey)}` : null;
    }
    case 'run':
      return lookup.runs.has(id) ? `/heartbeat/${encodeURIComponent(id)}` : null;
    case 'approval':
      return lookup.approvals.has(id) ? `/approval/${encodeURIComponent(id)}` : null;
    case 'project':
      return lookup.projects.has(id) ? `/project/${encodeURIComponent(id)}` : null;
    case 'goal':
      return lookup.goals.has(id) ? `/goal/${encodeURIComponent(id)}` : null;
  }
}

const UNKNOWN_LABEL: Record<ActivityItemKind, string> = {
  issue: 'Unknown issue',
  agent: 'Unknown agent',
  run: 'Unknown run',
  approval: 'Unknown approval',
  project: 'Unknown project',
  goal: 'Unknown goal',
};

export function linkFor(kind: ActivityItemKind, id: string, lookup: ActivityLookup): ActivityLink {
  const href = hrefFor(kind, id, lookup);
  let label: string | null = null;
  switch (kind) {
    case 'issue': {
      const issue = lookup.issues.get(id);
      if (issue) label = `${issue.identifier} ${issue.title}`;
      break;
    }
    case 'agent':
      label = lookup.agents.get(id)?.name ?? null;
      break;
    case 'run':
      label = lookup.runs.has(id) ? `run ${shortId(id)}` : null;
      break;
    case 'approval':
      label = lookup.approvals.get(id)?.title ?? null;
      break;
    case 'project':
      label = lookup.projects.get(id)?.title ?? null;
      break;
    case 'goal':
      label = lookup.goals.get(id)?.title ?? null;
      break;
  }
  return { kind, id, label: label ?? UNKNOWN_LABEL[kind], href: label ? href : null };
}

export type ActivityRefs = Record<ActivityItemKind, Set<string>>;

/** Every id the rows point at, by kind, so `lib/activity.ts` can load names in one query per kind. */
export function collectActivityRefs(entries: ActivityLogEntry[]): ActivityRefs {
  const refs: ActivityRefs = {
    issue: new Set(),
    agent: new Set(),
    run: new Set(),
    approval: new Set(),
    project: new Set(),
    goal: new Set(),
  };
  const add = (kind: ActivityItemKind, value: unknown) => {
    if (typeof value === 'string' && value) refs[kind].add(value);
  };
  for (const entry of entries) {
    const kind = ENTITY_KIND[entry.entityType];
    if (kind) add(kind, entry.entityId);
    if (entry.actorType === 'agent') add('agent', entry.actorId);
    const details = asRecord(entry.details);
    for (const [key, kindOf] of Object.entries(ID_FIELDS)) add(kindOf, details[key]);
    for (const [field, change] of Object.entries(asRecord(details.changes))) {
      const kindOf = ID_FIELDS[field];
      if (!kindOf) continue;
      const c = asRecord(change);
      add(kindOf, c.from);
      add(kindOf, c.to);
    }
    for (const key of ['issueIds', 'remainingBlockerIds', 'linkedIssueIds']) {
      const list = details[key];
      if (Array.isArray(list)) list.forEach((id) => add('issue', id));
    }
  }
  return refs;
}

export function excerptText(text: string, max = COMMENT_EXCERPT_CHARS): ActivityComment {
  const full = text.trim();
  if (full.length <= max) return { excerpt: full, full, truncated: false };
  const cut = full.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  const excerpt = (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd();
  return { excerpt: `${excerpt}…`, full, truncated: true };
}

function valueFor(field: string, value: unknown, lookup: ActivityLookup): ActivityChangeValue {
  const kind = ID_FIELDS[field];
  if (kind && typeof value === 'string' && value) return { link: linkFor(kind, value, lookup) };
  if (value === null || value === undefined || value === '') {
    if (field === 'assigneeAgentId' || field === 'ownerAgentId') return { text: 'nobody' };
    if (field === 'assigneeUserId') return { text: 'no' };
    return { text: 'none' };
  }
  if (field === 'assigneeUserId') return { text: 'yes' };
  if (field === 'description') return { text: excerptText(String(value), 60).excerpt };
  if (typeof value === 'string') return { text: value.replace(/_/g, ' ') };
  if (typeof value === 'boolean') return { text: value ? 'yes' : 'no' };
  return { text: JSON.stringify(value) };
}

/** "field from → to" lines: from `details.changes` (ACT-1 rows) or the legacy changed-field keys. */
export function describeActivityChanges(entry: ActivityLogEntry, lookup: ActivityLookup): ActivityChange[] {
  const details = asRecord(entry.details);
  const out: ActivityChange[] = [];
  const recorded = asRecord(details.changes);
  if (Object.keys(recorded).length > 0) {
    for (const [field, raw] of Object.entries(recorded)) {
      const label = CHANGE_FIELDS[field];
      if (!label) continue;
      const change = asRecord(raw);
      out.push({
        field,
        label,
        from: 'from' in change ? valueFor(field, change.from, lookup) : null,
        to: valueFor(field, change.to, lookup),
      });
    }
    return out;
  }

  if (!LEGACY_CHANGE_ACTIONS.has(entry.action)) return out;
  for (const [field, label] of Object.entries(CHANGE_FIELDS)) {
    if (!(field in details)) continue;
    if (field === 'status') {
      const to = details.status ?? details.newStatus;
      const from = details.previousStatus ?? details.priorStatus;
      out.push({ field, label, from: from === undefined ? null : valueFor(field, from, lookup), to: valueFor(field, to, lookup) });
      continue;
    }
    out.push({ field, label, from: null, to: valueFor(field, details[field], lookup) });
  }
  if (!('status' in details) && 'newStatus' in details) {
    out.unshift({
      field: 'status',
      label: 'Status',
      from: details.previousStatus === undefined ? null : valueFor('status', details.previousStatus, lookup),
      to: valueFor('status', details.newStatus, lookup),
    });
  }
  return out;
}

const OUTCOME_WORDS: Record<string, string> = {
  approved: 'approved',
  rejected: 'rejected',
  answered: 'answered',
  declined: 'declined',
  cancelled: 'cancelled',
  expired: 'expired',
};

function decisionOf(entry: ActivityLogEntry): ActivityDecision | null {
  const details = asRecord(entry.details);
  if (entry.action === 'approval.decided') {
    const outcome = str(details.status) ?? str(details.decision) ?? 'decided';
    return {
      outcome: OUTCOME_WORDS[outcome] ?? outcome,
      reason: str(details.reason) ?? str(details.note),
      answer: str(details.answer),
    };
  }
  if (str(details.decision) && str(details.approvalId)) {
    const outcome = String(details.decision);
    return { outcome: OUTCOME_WORDS[outcome] ?? outcome, reason: str(details.note), answer: null };
  }
  return null;
}

function commentOf(entry: ActivityLogEntry): ActivityComment | null {
  const details = asRecord(entry.details);
  const text = str(details.comment) ?? str(details.body);
  return text ? excerptText(text) : null;
}

const SYSTEM_NAMES: Record<string, string> = {
  board: 'Board',
  hitly: 'HITLy',
  mcp: 'MCP',
  deadline: 'Deadline',
  'wake-runner': 'Scheduler',
  'goal-cascade': 'Goal cascade',
  'hitly-forward': 'HITLy hand-off',
};

export function describeActivityActor(entry: ActivityLogEntry, lookup: ActivityLookup): ActivityActorView {
  const details = asRecord(entry.details);
  const runId = str(details.runId);
  // Only a heartbeat run of this company gets a link (chat-session run ids are not runs).
  const run = runId && lookup.runs.has(runId) ? linkFor('run', runId, lookup) : null;
  const base: ActivityActorView = {
    type: entry.actorType,
    id: entry.actorId,
    label: '',
    href: null,
    run: null,
    viaApproval: null,
    viaDecider: null,
    viaOutcome: null,
  };
  if (entry.actorType === 'agent') {
    const agent = lookup.agents.get(entry.actorId);
    return {
      ...base,
      label: agent ? `Agent ${agent.name}` : 'Unknown agent',
      href: agent ? `/agent/${encodeURIComponent(agent.urlKey)}` : null,
      run,
    };
  }
  if (entry.actorType === 'user') {
    const name = entry.actorName ?? SYSTEM_NAMES[entry.actorId] ?? 'Board user';
    return { ...base, label: name, run };
  }
  // System: say what it acted for when the row came from an approval decision.
  const approvalId = entry.entityType === 'approval' ? null : str(details.approvalId);
  const decider = entry.actorName ?? SYSTEM_NAMES[entry.actorId] ?? null;
  if (approvalId) {
    const decision = str(details.decision) ?? str(details.status);
    return {
      ...base,
      label: 'System',
      viaApproval: linkFor('approval', approvalId, lookup),
      viaDecider: decider,
      viaOutcome: decision ? (OUTCOME_WORDS[decision] ?? decision) : null,
      run,
    };
  }
  return { ...base, label: decider && decider !== 'System' ? `System (${decider})` : 'System', run };
}

function relatedOf(entry: ActivityLogEntry, lookup: ActivityLookup, item: ActivityLink | null): ActivityLink[] {
  const details = asRecord(entry.details);
  const seen = new Set<string>(item ? [`${item.kind}:${item.id}`] : []);
  const out: ActivityLink[] = [];
  const push = (kind: ActivityItemKind, id: unknown) => {
    if (typeof id !== 'string' || !id) return;
    const key = `${kind}:${id}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(linkFor(kind, id, lookup));
  };
  if (entry.entityType !== 'approval') push('approval', details.approvalId);
  for (const key of ['issueIds', 'remainingBlockerIds']) {
    const list = details[key];
    if (Array.isArray(list)) list.forEach((id) => push('issue', id));
  }
  if (entry.action === 'project.auto_paused' || entry.action === 'project.auto_resumed') push('goal', details.goalId);
  return out;
}

export function buildActivityView(entry: ActivityLogEntry, lookup: ActivityLookup): ActivityView {
  const kind = ENTITY_KIND[entry.entityType];
  const item = kind ? linkFor(kind, entry.entityId, lookup) : null;
  return {
    id: entry.id,
    createdAt: entry.createdAt,
    action: entry.action,
    actionLabel: formatActivityAction(entry.action),
    entityType: entry.entityType,
    entityId: entry.entityId,
    item,
    actor: describeActivityActor(entry, lookup),
    changes: describeActivityChanges(entry, lookup),
    comment: commentOf(entry),
    decision: decisionOf(entry),
    related: relatedOf(entry, lookup, item),
    correlationId: entry.correlationId ?? null,
    details: asRecord(entry.details),
  };
}

export interface ActivityGroup {
  /** Null for a row on its own. */
  correlationId: string | null;
  rows: ActivityView[];
}

/**
 * Rows that share a correlation id form one group, placed where its newest row is (rows come in
 * newest first). Rows without one are groups of one. Order inside a group is kept.
 */
export function groupActivityViews(views: ActivityView[]): ActivityGroup[] {
  const groups: ActivityGroup[] = [];
  const byId = new Map<string, ActivityGroup>();
  for (const view of views) {
    if (!view.correlationId) {
      groups.push({ correlationId: null, rows: [view] });
      continue;
    }
    const existing = byId.get(view.correlationId);
    if (existing) {
      existing.rows.push(view);
      continue;
    }
    const group = { correlationId: view.correlationId, rows: [view] };
    byId.set(view.correlationId, group);
    groups.push(group);
  }
  return groups;
}

export interface ActivityFilters {
  entityType: ActivityEntityType | null;
  /** 'agent:<id>', 'user' or 'system'. */
  actor: { type: 'agent'; id: string } | { type: 'user' } | { type: 'system' } | null;
  /** Inclusive start (00:00 UTC of the from date). */
  from: Date | null;
  /** Exclusive end (00:00 UTC of the day after the to date). */
  toExclusive: Date | null;
  correlationId: string | null;
  /** Raw values, to refill the form. */
  raw: { type: string; actor: string; from: string; to: string; correlation: string };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function parseDay(value: string): Date | null {
  if (!DATE_RE.test(value)) return null;
  const d = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value ? null : d;
}

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? '';
}

/** Search params → filters. Anything malformed is ignored (no filter), never an error. */
export function parseActivityFilters(params: Record<string, string | string[] | undefined>): ActivityFilters {
  const type = first(params.type).trim();
  const actor = first(params.actor).trim();
  const from = first(params.from).trim();
  const to = first(params.to).trim();
  const correlation = first(params.correlation).trim();

  const entityType = (ACTIVITY_ENTITY_TYPES as readonly string[]).includes(type) ? (type as ActivityEntityType) : null;
  let actorFilter: ActivityFilters['actor'] = null;
  if (actor === 'user' || actor === 'system') actorFilter = { type: actor };
  else if (actor.startsWith('agent:') && ID_RE.test(actor.slice(6))) actorFilter = { type: 'agent', id: actor.slice(6) };

  const fromDate = parseDay(from);
  const toDay = parseDay(to);
  const toExclusive = toDay ? new Date(toDay.getTime() + 24 * 60 * 60 * 1000) : null;

  return {
    entityType,
    actor: actorFilter,
    from: fromDate,
    toExclusive,
    correlationId: ID_RE.test(correlation) ? correlation : null,
    raw: {
      type: entityType ?? '',
      actor: actorFilter ? actor : '',
      from: fromDate ? from : '',
      to: toDay ? to : '',
      correlation: ID_RE.test(correlation) ? correlation : '',
    },
  };
}

export function hasActiveFilters(filters: ActivityFilters): boolean {
  return Boolean(filters.entityType || filters.actor || filters.from || filters.toExclusive || filters.correlationId);
}

/** Absolute timestamp for hover text, e.g. "2026-10-24 21:32:05 UTC". */
export function absoluteTimestamp(date: Date): string {
  return `${date.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

export function formatRelativeTime(date: Date, now = Date.now()): string {
  const seconds = Math.floor((now - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return date.toISOString().slice(0, 10);
}
