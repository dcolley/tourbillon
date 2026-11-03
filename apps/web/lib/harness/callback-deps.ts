/**
 * #281 — production deps for the Hermes callback gate routes.
 *
 * THE capability gate is `assembleAgentTools` — identical to the in-system heartbeat assembly
 * (control plane + assignedToolsets + runtimeConfig.assignedTools + company-allowed MCP
 * servers, with the company-settings web-search/tavily/mail pruning). External harness calls
 * get no side channel around it. The session token the harness authenticated with becomes the
 * tools' `apiKey` so their own /api calls re-enter the normal run-token auth (#110).
 */
import { db, agents, companies } from '@tourbillon/db';
import { and, eq } from 'drizzle-orm';
import { assembleAgentTools, createHeartbeatRuntimeContext } from '@tourbillon/mastra';
import { parseCompanySettings } from '@tourbillon/shared';
import type { HarnessCallbackDeps } from './callback-gate';
import { authenticateAgentToken } from '../auth/agent-token-auth';

export function buildHarnessCallbackDeps(): HarnessCallbackDeps {
  return {
    authenticate: (token) => authenticateAgentToken(token),
    loadAgent: async (agentId, companyId) =>
      (await db.query.agents.findFirst({
        where: and(eq(agents.id, agentId), eq(agents.companyId, companyId)),
      })) ?? null,
    loadCompany: async (companyId) =>
      (await db.query.companies.findFirst({ where: eq(companies.id, companyId) })) ?? null,
    assembleTools: async (agent, options) =>
      assembleAgentTools(agent as never, {
        allowedMcpServerIds: options.allowedMcpServerIds,
        companySettings: parseCompanySettings(options.companySettings),
      }),
    buildRequestContext: (values) => createHeartbeatRuntimeContext(values),
  };
}
