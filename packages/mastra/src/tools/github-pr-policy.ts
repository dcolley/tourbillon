/**
 * Server-side GitHub MCP wrapper: draft-only PRs, protected-branch blocks,
 * activity on deny, Auto Test issue on agent-opened PR.
 */
import {
  BOARD_USER_ID,
  classifyGithubTool,
  evaluateGithubAgentPrPolicy,
  extractPullRequestUrl,
  buildAgentPrTestIssueDescription,
  buildAgentPrTestIssueTitle,
  GITHUB_POLICY_BLOCKED_ACTION,
  resolveAgentPrPolicy,
  type CompanySettings,
  type ResolvedAgentPrPolicy,
} from '@tourbillon/shared';
import { extractToolRuntimeContext, tracedAgentFetch } from './api-client';

export interface GithubPolicyWrapContext {
  companyId: string;
  agentId: string;
  agentName?: string | null;
  companySettings?: CompanySettings | null;
  logBlocked?: (event: GithubPolicyBlockedEvent) => Promise<void>;
  afterPullRequestCreated?: (event: GithubPolicyPrOpenedEvent) => Promise<void>;
  resolveDefaultBranch?: (args: Record<string, unknown>) => Promise<string | null>;
}

export interface GithubPolicyBlockedEvent {
  companyId: string;
  agentId: string;
  agentName?: string | null;
  toolName: string;
  code: string;
  reason: string;
  args: Record<string, unknown>;
}

export interface GithubPolicyPrOpenedEvent {
  companyId: string;
  agentId: string;
  agentName?: string | null;
  policy: ResolvedAgentPrPolicy;
  requestContext: unknown;
  args: Record<string, unknown>;
  result: unknown;
}

const defaultBranchCache = new Map<string, string | null>();

export function isGithubPolicyRelevantTool(toolName: string): boolean {
  return classifyGithubTool(toolName) !== 'other';
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function requestContextFromExecute(execContext: unknown): unknown {
  if (execContext && typeof execContext === 'object' && 'requestContext' in execContext) {
    return (execContext as { requestContext: unknown }).requestContext;
  }
  return execContext;
}

export async function logGithubPolicyBlocked(event: GithubPolicyBlockedEvent): Promise<void> {
  const { db, activityLog } = await import('@tourbillon/db');
  await db.insert(activityLog).values({
    companyId: event.companyId,
    actorType: 'agent',
    actorId: event.agentId,
    actorName: event.agentName ?? null,
    action: GITHUB_POLICY_BLOCKED_ACTION,
    entityType: 'github',
    entityId: event.toolName,
    details: {
      tool: event.toolName,
      code: event.code,
      reason: event.reason,
      args: sanitizePolicyArgs(event.args),
    },
  });
}

function sanitizePolicyArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of [
    'owner',
    'repo',
    'branch',
    'ref',
    'base',
    'head',
    'path',
    'pull_number',
    'draft',
    'title',
  ]) {
    if (key in args) out[key] = args[key];
  }
  return out;
}

export async function createAgentPrTestIssue(event: GithubPolicyPrOpenedEvent): Promise<void> {
  const runtime = extractToolRuntimeContext(event.requestContext);
  const companyId = runtime.companyId ?? event.companyId;
  if (!companyId) return;

  const prUrl = extractPullRequestUrl(event.result);
  const prTitle = typeof event.args.title === 'string' ? event.args.title : undefined;
  const title = buildAgentPrTestIssueTitle(prTitle);
  const description = buildAgentPrTestIssueDescription({
    prUrl,
    prTitle,
    openedByAgentName: event.agentName,
  });

  const testAgentId = event.policy.testAgentId;
  const assignee: { assigneeAgentId?: string; assigneeUserId?: string } = testAgentId
    ? { assigneeAgentId: testAgentId }
    : { assigneeUserId: BOARD_USER_ID };

  const body = {
    title,
    description,
    priority: 'high' as const,
    ...assignee,
  };

  const res = await tracedAgentFetch(
    'agentPrPolicyAutoTest',
    event.requestContext,
    `/api/companies/${companyId}/issues`,
    { method: 'POST', body: JSON.stringify(body) },
  );

  if (!res.ok && assignee.assigneeAgentId) {
    await tracedAgentFetch(
      'agentPrPolicyAutoTest',
      event.requestContext,
      `/api/companies/${companyId}/issues`,
      {
        method: 'POST',
        body: JSON.stringify({
          title,
          description,
          priority: 'high',
          assigneeUserId: BOARD_USER_ID,
        }),
      },
    );
  }
}

async function resolveRepoDefaultBranch(args: Record<string, unknown>): Promise<string | null> {
  const owner = typeof args.owner === 'string' ? args.owner.trim() : '';
  const repo = typeof args.repo === 'string' ? args.repo.trim() : '';
  if (!owner || !repo) return null;

  const cacheKey = `${owner}/${repo}`;
  if (defaultBranchCache.has(cacheKey)) return defaultBranchCache.get(cacheKey) ?? null;

  const token = process.env.GITHUB_TOKEN || process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
  if (!token) return null;

  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
      },
    });
    if (!res.ok) {
      defaultBranchCache.set(cacheKey, null);
      return null;
    }
    const data = (await res.json()) as { default_branch?: unknown };
    const branch = typeof data.default_branch === 'string' ? data.default_branch : null;
    defaultBranchCache.set(cacheKey, branch);
    return branch;
  } catch {
    defaultBranchCache.set(cacheKey, null);
    return null;
  }
}

function wrapToolExecute(
  toolName: string,
  tool: Record<string, unknown>,
  ctx: GithubPolicyWrapContext,
  policy: ResolvedAgentPrPolicy,
): Record<string, unknown> {
  const originalExecute = tool.execute;
  if (typeof originalExecute !== 'function') return tool;

  const execute = originalExecute.bind(tool);

  return {
    ...tool,
    execute: async (inputData: unknown, execContext: unknown) => {
      const args = asRecord(inputData);
      const defaultBranch = ctx.resolveDefaultBranch
        ? await ctx.resolveDefaultBranch(args)
        : await resolveRepoDefaultBranch(args);

      const decision = evaluateGithubAgentPrPolicy({
        toolName,
        args,
        policy,
        defaultBranch,
      });

      if (decision.action === 'block') {
        const event: GithubPolicyBlockedEvent = {
          companyId: ctx.companyId,
          agentId: ctx.agentId,
          agentName: ctx.agentName,
          toolName,
          code: decision.code,
          reason: decision.reason,
          args,
        };
        try {
          await (ctx.logBlocked ?? logGithubPolicyBlocked)(event);
        } catch (err) {
          console.warn('[github-pr-policy] failed to write blocked activity', err);
        }
        return {
          error: 'github_policy_blocked',
          code: decision.code,
          message: decision.reason,
        };
      }

      const forwarded = decision.action === 'force_draft' ? decision.patchedArgs : args;
      const result = await execute(forwarded, execContext);

      if (classifyGithubTool(toolName) === 'create_pr' && result && !isToolError(result)) {
        try {
          await (ctx.afterPullRequestCreated ?? createAgentPrTestIssue)({
            companyId: ctx.companyId,
            agentId: ctx.agentId,
            agentName: ctx.agentName,
            policy,
            requestContext: requestContextFromExecute(execContext),
            args: forwarded,
            result,
          });
        } catch (err) {
          console.warn('[github-pr-policy] failed to create Auto Test issue', err);
        }
      }

      return result;
    },
  };
}

function isToolError(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const record = result as Record<string, unknown>;
  if (record.error) return true;
  if (record.isError === true) return true;
  return false;
}

/**
 * Wrap GitHub MCP tools after the allow-list filter. No-op when policy is off.
 * Clones tool objects so the MCP client cache is not mutated.
 */
export function wrapGithubMcpTools(
  tools: Record<string, unknown>,
  ctx: GithubPolicyWrapContext,
): Record<string, unknown> {
  const policy = resolveAgentPrPolicy(ctx.companySettings);
  if (!policy.enabled) return tools;

  const wrapped: Record<string, unknown> = {};
  for (const [name, tool] of Object.entries(tools)) {
    if (!tool || typeof tool !== 'object' || !isGithubPolicyRelevantTool(name)) {
      wrapped[name] = tool;
      continue;
    }
    wrapped[name] = wrapToolExecute(name, tool as Record<string, unknown>, ctx, policy);
  }
  return wrapped;
}
