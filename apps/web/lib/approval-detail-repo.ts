/** Drizzle implementation of ApprovalDetailRepo. Every query filters on company_id. */
import { db, approvals, agents, issues, activityLog, companies } from '@tourbillon/db';
import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import type { ApprovalDetailRepo } from './approval-detail';

type Db = typeof db;

export function createApprovalDetailRepo(database: Db = db): ApprovalDetailRepo {
  return {
    async getApproval(companyId, approvalId) {
      const [row] = await database
        .select()
        .from(approvals)
        .where(and(eq(approvals.id, approvalId), eq(approvals.companyId, companyId)))
        .limit(1);
      return row ?? null;
    },
    async getAgent(companyId, agentId) {
      const [row] = await database
        .select({
          id: agents.id,
          companyId: agents.companyId,
          name: agents.name,
          urlKey: agents.urlKey,
          runtimeConfig: agents.runtimeConfig,
        })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
        .limit(1);
      return row ?? null;
    },
    async getIssues(companyId, issueIds) {
      if (issueIds.length === 0) return [];
      return database
        .select({
          id: issues.id,
          companyId: issues.companyId,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          boardApprovalId: issues.boardApprovalId,
        })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), inArray(issues.id, issueIds)));
    },
    async getActivity(companyId, approvalId, issueIds) {
      const aboutApproval = and(eq(activityLog.entityType, 'approval'), eq(activityLog.entityId, approvalId));
      const issueRowsCitingIt =
        issueIds.length > 0
          ? and(
              eq(activityLog.entityType, 'issue'),
              inArray(activityLog.entityId, issueIds),
              or(
                sql`${activityLog.details}->>'approvalId' = ${approvalId}`,
                sql`${activityLog.details}->>'boardApprovalId' = ${approvalId}`,
              ),
            )
          : undefined;
      return database
        .select()
        .from(activityLog)
        .where(and(eq(activityLog.companyId, companyId), issueRowsCitingIt ? or(aboutApproval, issueRowsCitingIt) : aboutApproval))
        .orderBy(asc(activityLog.createdAt))
        .limit(500);
    },
    async getCompanySettings(companyId) {
      const [row] = await database
        .select({ settings: companies.settings })
        .from(companies)
        .where(eq(companies.id, companyId))
        .limit(1);
      return row?.settings ?? null;
    },
  };
}
