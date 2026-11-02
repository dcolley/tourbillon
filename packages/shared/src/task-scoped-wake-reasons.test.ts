/**
 * #295 S295-S2: parity pins for the task-scoped wake-reason set.
 *
 * Before this soft, packages/scheduler/src/wake-runner.ts (TASK_SCOPED_WAKE_REASONS) and
 * apps/web/lib/retry-failed-heartbeat.ts (TASK_SCOPED_REASONS) each held their own copy of
 * the five members, "kept in sync deliberately" — with no pin, dropping
 * `issue_comment_mentioned`, `issue_blockers_resolved` or `issue_children_completed` from
 * either copy survived the whole suite. The set now lives HERE and both consumers import it;
 * these pins keep it that way:
 *  1. the set's exact membership (drop-or-add any member → RED here, and the per-member
 *     behavioural tests in wake-runner-295-softs.test.ts (scheduler assignee gate) and
 *     retry-failed-heartbeat.test.ts (web retry) go RED with it);
 *  2. no consumer re-grows a local copy — both sources must import the shared name and
 *     must not define a local set of the same shape.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TASK_SCOPED_WAKE_REASONS } from './task-scoped-wake-reasons';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const SCHEDULER_SRC = path.join(REPO_ROOT, 'packages/scheduler/src/wake-runner.ts');
const WEB_SRC = path.join(REPO_ROOT, 'apps/web/lib/retry-failed-heartbeat.ts');

/** The canonical five, written out independently of the set under test. */
const CANONICAL = [
  'assignment',
  'issue_commented',
  'issue_comment_mentioned',
  'issue_blockers_resolved',
  'issue_children_completed',
] as const;

function stringArrayLiteral(source: string, constName: string): string[] {
  const match = source.match(new RegExp(`const ${constName}\\b[^=]*=\\s*new Set\\([^)]*\\)`, 's'));
  if (!match) throw new Error(`source must define const ${constName}`);
  return [...match[0].matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

describe('TASK_SCOPED_WAKE_REASONS (#295 S295-S2 shared set)', () => {
  it('holds exactly the five task-scoped wake reasons', () => {
    assert.deepEqual(
      [...TASK_SCOPED_WAKE_REASONS].sort(),
      [...CANONICAL].sort(),
      `dropping or adding a member here silently re-opens the #275 assignee-gate / retry-context hole`,
    );
  });

  for (const reason of CANONICAL) {
    it(`contains '${reason}' (per-member pin)`, () => {
      assert.ok(
        TASK_SCOPED_WAKE_REASONS.has(reason),
        `'${reason}' must stay task-scoped: the scheduler would skip the assignee-mismatch ` +
          `pre-flight for it and the web retry would degrade it to on_demand`,
      );
    });
  }

  it('excludes the context-free reasons and approval_resolved', () => {
    for (const reason of [
      'timer',
      'on_demand',
      'automation',
      'agent_mail',
      'approval_resolved',
    ] as const) {
      assert.equal(
        TASK_SCOPED_WAKE_REASONS.has(reason),
        false,
        `'${reason}' must NOT be task-scoped: its taskId is context, not an assignment ` +
          `(approval_resolved is the #275 bug itself)`,
      );
    }
  });

  describe('consumer parity (no local copies may regrow)', () => {
    for (const [label, file, importFrom] of [
      ['scheduler wake-runner', SCHEDULER_SRC, '@tourbillon/shared'],
      ['web retry-failed-heartbeat', WEB_SRC, '@tourbillon/shared'],
    ] as const) {
      it(`${label} imports the shared set instead of redefining it`, () => {
        const source = readFileSync(file, 'utf8');
        assert.match(
          source,
          /import\s*{[^}]*\bTASK_SCOPED_WAKE_REASONS\b[^}]*}\s*from\s*'@tourbillon\/shared(-task-scoped-wake-reasons)?'/s,
          `${label} must import TASK_SCOPED_WAKE_REASONS from @tourbillon/shared`,
        );
        assert.doesNotMatch(
          source,
          /const\s+TASK_SCOPED_\w+\s*[:=][^;]*new\s+Set/s,
          `${label} must not hold a local TASK_SCOPED_* set — that is the drift the shared set exists to prevent`,
        );
        assert.ok(importFrom === '@tourbillon/shared');
      });
    }

    it('web VALID_WAKE_REASONS stays the union of task-scoped + context-free + approval_resolved', () => {
      const source = readFileSync(WEB_SRC, 'utf8');
      const valid = stringArrayLiteral(source, 'VALID_WAKE_REASONS');
      const contextFree = stringArrayLiteral(source, 'CONTEXT_FREE_REASONS');
      assert.deepEqual(
        [...valid].sort(),
        [...new Set([...TASK_SCOPED_WAKE_REASONS, ...contextFree, 'approval_resolved'])].sort(),
        'a reason that is task-scoped but not VALID silently degrades its retry to on_demand ' +
          '(the VALID gate runs before the task-scoped branch in buildRetryHeartbeatJobData)',
      );
      for (const reason of TASK_SCOPED_WAKE_REASONS) {
        assert.equal(
          contextFree.includes(reason),
          false,
          `'${reason}' must not also be context-free: the retry would replay it without its taskId/payload guard`,
        );
      }
    });
  });
});
