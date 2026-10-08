/** SQL shape of the approval details repo (fake postgres client, no DB): every query is company-scoped. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { drizzle } from 'drizzle-orm/postgres-js';
import { createApprovalDetailRepo } from './approval-detail-repo';

function recordingDb() {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    options: { parsers: {}, serializers: {} },
    unsafe(sql: string, params: unknown[]) {
      calls.push({ sql, params });
      const p = Promise.resolve([]) as unknown as Promise<unknown[]> & { values: () => Promise<unknown[]> };
      p.values = () => Promise.resolve([]);
      return p;
    },
  };
  return { db: drizzle(client as never), calls };
}

describe('approval details repo: company scoping in SQL', () => {
  const { db, calls } = recordingDb();
  const repo = createApprovalDetailRepo(db as never);

  it('approval, agent, issues, activity and settings queries all filter on the company', async () => {
    await repo.getApproval('company-a', 'appr-a');
    await repo.getAgent('company-a', 'agent-a');
    await repo.getIssues('company-a', ['issue-1', 'issue-2']);
    await repo.getActivity('company-a', 'appr-a', ['issue-1']);
    await repo.getCompanySettings('company-a');
    assert.equal(calls.length, 5);
    const [approval, agent, issues, activity, settings] = calls;
    assert.match(approval.sql, /from "approvals" where \("approvals"\."id" = \$1 and "approvals"\."company_id" = \$2\)/);
    assert.deepEqual(approval.params.slice(0, 2), ['appr-a', 'company-a']);
    assert.match(agent.sql, /"agents"\."company_id" = \$2/);
    assert.match(issues.sql, /"issues"\."company_id" = \$1 and "issues"\."id" in \(\$2, \$3\)/);
    assert.match(activity.sql, /where \("activity_log"\."company_id" = \$1 and/);
    assert.match(activity.sql, /->>'approvalId' = \$\d+/);
    assert.match(activity.sql, /->>'boardApprovalId' = \$\d+/);
    assert.match(activity.sql, /order by "activity_log"\."created_at" asc/);
    assert.equal(activity.params[0], 'company-a');
    assert.match(settings.sql, /from "companies" where "companies"\."id" = \$1/);
  });

  it('no linked issues: activity is only rows about the approval itself; no issue query', async () => {
    calls.length = 0;
    assert.deepEqual(await repo.getIssues('company-a', []), []);
    await repo.getActivity('company-a', 'appr-a', []);
    assert.equal(calls.length, 1);
    assert.doesNotMatch(calls[0].sql, /approvalId/);
    assert.match(calls[0].sql, /"activity_log"\."entity_type" = \$\d+ and "activity_log"\."entity_id" = \$\d+/);
  });
});
