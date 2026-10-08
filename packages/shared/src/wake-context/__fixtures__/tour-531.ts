/**
 * Loader for the sanitised TOUR-531 replay (run 6f24587d). Builds the WakeLiveContext the
 * scheduler's buildWakeContext would produce from these rows; the scheduler test checks that
 * its DB assembly gives the same object.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HeartbeatJobData, WakePayload } from '../../types';
import type { WakeLiveContext } from '../types';

export interface Tour531Fixture {
  companyId: string;
  runStartedAt: string;
  agent: { id: string; name: string; urlKey: string };
  wake: HeartbeatJobData;
  payload: WakePayload;
  issues: Array<{
    id: string;
    companyId: string;
    identifier: string;
    title: string;
    status: string;
    priority: string;
    assigneeAgentId: string | null;
    assigneeUserId: string | null;
    parentId: string | null;
    blockedByIssueIds: string[];
  }>;
  approvals: Array<{
    id: string;
    companyId: string;
    type: string;
    status: string;
    note: string | null;
    decidedAt: string | null;
    createdAt: string;
    issueIds: string[];
    payload: Record<string, unknown>;
  }>;
  activity: Array<{ actorType: string; actorId: string; action: string; createdAt: string; hasComment: boolean }>;
}

export function loadTour531Fixture(): Tour531Fixture {
  return JSON.parse(readFileSync(join(__dirname, 'tour-531-6f24587d.json'), 'utf8')) as Tour531Fixture;
}

export function tour531Job(fx: Tour531Fixture = loadTour531Fixture()): HeartbeatJobData {
  return { ...fx.wake, wakePayloadJson: JSON.stringify(fx.payload) };
}

export function tour531Context(fx: Tour531Fixture = loadTour531Fixture()): WakeLiveContext {
  const task = fx.issues.find((i) => i.id === fx.wake.taskId)!;
  const byId = new Map(fx.issues.map((i) => [i.id, i]));
  const run = Date.parse(fx.runStartedAt);
  const mine = fx.activity
    .filter((a) => a.actorType === 'agent' && a.actorId === fx.agent.id && Date.parse(a.createdAt) < run)
    .map((a) => a.createdAt)
    .sort();
  const lastActivityAt = mine.length ? new Date(mine[mine.length - 1]).toISOString() : null;
  const since = lastActivityAt ? Date.parse(lastActivityAt) : -Infinity;
  const parent = task.parentId ? byId.get(task.parentId) : undefined;
  return {
    version: 1,
    asOf: fx.runStartedAt,
    agent: fx.agent,
    task: {
      id: task.id,
      identifier: task.identifier,
      title: task.title,
      status: task.status,
      priority: task.priority,
      assignee: { kind: 'self', name: fx.agent.name },
    },
    parent: parent ? { identifier: parent.identifier, status: parent.status } : null,
    blockers: task.blockedByIssueIds
      .map((id) => byId.get(id))
      .filter((i): i is NonNullable<typeof i> => Boolean(i))
      .map((i) => ({ identifier: i.identifier, status: i.status })),
    approvals: [...fx.approvals].sort((a, b) => (a.id < b.id ? -1 : 1)).map((a) => ({
      id: a.id,
      status: a.status,
      decidedAt: a.decidedAt,
      createdAt: a.createdAt,
      note: a.note,
      title: null,
      linked: a.issueIds.includes(task.id),
    })),
    referencedIssues: fx.issues
      .filter((i) => i.id !== task.id)
      .map((i) => ({ identifier: i.identifier, status: i.status })),
    lastActivityAt,
    userCommentsSinceLastActivity: fx.activity.filter(
      (a) =>
        a.actorType === 'user' &&
        a.hasComment &&
        Date.parse(a.createdAt) > since &&
        Date.parse(a.createdAt) < run,
    ).length,
  };
}
