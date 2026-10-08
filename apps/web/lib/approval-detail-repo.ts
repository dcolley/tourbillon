/** Drizzle implementation of ApprovalDetailRepo. Every query filters on company_id. */
import { db, approvals, agents, issues, activityLog, companies, llmProviders, vaultSecrets } from '@tourbillon/db';
import { and, arrayOverlaps, asc, desc, eq, inArray, ne, or, sql } from 'drizzle-orm';
import { collectSecretValueEntries } from '@tourbillon/shared';
import { RELATED_APPROVALS_LIMIT, type ApprovalDetailRepo } from './approval-detail';
import { vaultValuesForRedaction } from './approval-redaction';
import { providerSecretValues } from './provider-safety';

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
    async getRelatedApprovals(companyId, approvalId, issueIds) {
      if (issueIds.length === 0) return [];
      return database
        .select()
        .from(approvals)
        .where(
          and(
            eq(approvals.companyId, companyId),
            ne(approvals.id, approvalId),
            arrayOverlaps(approvals.issueIds, issueIds),
          ),
        )
        .orderBy(desc(approvals.createdAt))
        .limit(RELATED_APPROVALS_LIMIT);
    },
    async getCompanySettings(companyId) {
      const [row] = await database
        .select({ settings: companies.settings })
        .from(companies)
        .where(eq(companies.id, companyId))
        .limit(1);
      return row?.settings ?? null;
    },
    async getSecretValues(companyId) {
      const [vaultRows, agentRows, providerRows] = await Promise.all([
        database
          .select({ id: vaultSecrets.id, encryptedValue: vaultSecrets.encryptedValue })
          .from(vaultSecrets)
          .where(eq(vaultSecrets.companyId, companyId)),
        database
          .select({ runtimeConfig: agents.runtimeConfig })
          .from(agents)
          .where(eq(agents.companyId, companyId)),
        // llm_providers is the instance-wide registry (no company_id): every key is scrubbed.
        database
          .select({ apiKey: llmProviders.apiKey, headers: llmProviders.headers, baseURL: llmProviders.baseURL })
          .from(llmProviders),
      ]);
      // B3: rows that can't be decrypted are reported (vaultUnavailable), never silently dropped.
      const vault = vaultValuesForRedaction(vaultRows);
      const values = [
        ...vault.values,
        ...agentRows.flatMap((r) => collectSecretValueEntries(r.runtimeConfig).map(([, v]) => v)),
        ...providerRows.flatMap((r) =>
          providerSecretValues({
            apiKey: r.apiKey,
            headers: (r.headers ?? {}) as Record<string, string>,
            baseURL: r.baseURL,
          }),
        ),
      ];
      return { values, vaultUnavailable: vault.vaultUnavailable };
    },
  };
}
