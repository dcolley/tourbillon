/** Company Agent PR policy — draft-only PRs, protected-branch writes, Test gates. */

export const DEFAULT_PROTECTED_BRANCH_PATTERNS = ['main', 'master', 'release/*'] as const;

export const GITHUB_AGENT_PR_POLICY_PROMPT =
  'GitHub: open draft PRs only, never push to main or other protected branches, wait for the Test gate, and leave merge to a human. Server-side policy enforces this.';

export const GITHUB_POLICY_BLOCKED_ACTION = 'agent.github_policy_blocked';
export const AGENT_PR_POLICY_DISABLED_ACTION = 'company.agent_pr_policy_disabled';

export interface AgentPrPolicySettings {
  /** Default true when omitted. */
  enabled?: boolean;
  /** Glob-style patterns. Default: main, master, release/*. */
  protectedBranchPatterns?: string[];
  /** Company agent that receives Auto Test issues. Unset → Board. */
  testAgentId?: string;
}

export interface ResolvedAgentPrPolicy {
  enabled: boolean;
  protectedBranchPatterns: string[];
  testAgentId: string | null;
}

export type GithubPolicyBlockCode =
  | 'merge_blocked'
  | 'ready_for_review_blocked'
  | 'protected_branch_write'
  | 'protected_branch_delete'
  | 'repo_settings_blocked';

export type GithubPolicyDecision =
  | { action: 'allow' }
  | { action: 'force_draft'; patchedArgs: Record<string, unknown> }
  | { action: 'block'; reason: string; code: GithubPolicyBlockCode };

export type GithubToolClass =
  | 'create_pr'
  | 'merge'
  | 'update_pr'
  | 'mark_ready'
  | 'file_write'
  | 'create_branch'
  | 'delete_branch'
  | 'ref_update'
  | 'repo_settings'
  | 'other';

/** Strip refs/heads/ and origin/ so pattern matching sees the branch name. */
export function normalizeBranchName(ref: string): string {
  let name = ref.trim();
  if (name.startsWith('refs/heads/')) name = name.slice('refs/heads/'.length);
  else if (name.startsWith('refs/')) name = name.replace(/^refs\/[^/]+\//, '');
  if (name.startsWith('origin/')) name = name.slice('origin/'.length);
  return name;
}

/**
 * Glob match for branch names. `*` matches one path segment; `**` matches across `/`.
 * `release/*` matches `release/1.0` but not `release/1.0/hotfix`.
 */
export function matchBranchPattern(branch: string, pattern: string): boolean {
  const name = normalizeBranchName(branch);
  const glob = pattern.trim();
  if (!name || !glob) return false;
  if (name === glob) return true;

  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/{{GLOBSTAR}}/g, '.*');
  return new RegExp(`^${escaped}$`).test(name);
}

export function matchProtectedBranch(branch: string, patterns: readonly string[]): boolean {
  const name = normalizeBranchName(branch);
  if (!name) return false;
  return patterns.some((pattern) => matchBranchPattern(name, pattern));
}

export function parseProtectedBranchPatterns(raw: unknown): string[] | undefined {
  if (Array.isArray(raw)) {
    const patterns = raw
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter(Boolean);
    return patterns.length > 0 ? patterns : undefined;
  }
  if (typeof raw === 'string') {
    const patterns = raw
      .split(/[\n,]+/)
      .map((value) => value.trim())
      .filter(Boolean);
    return patterns.length > 0 ? patterns : undefined;
  }
  return undefined;
}

export function parseAgentPrPolicySettings(raw: unknown): AgentPrPolicySettings | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  const enabled =
    record.enabled === false ? false : record.enabled === true ? true : undefined;
  const protectedBranchPatterns = parseProtectedBranchPatterns(record.protectedBranchPatterns);
  const testAgentId =
    typeof record.testAgentId === 'string' ? record.testAgentId.trim() || undefined : undefined;
  if (enabled === undefined && !protectedBranchPatterns && !testAgentId) return undefined;
  return {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(protectedBranchPatterns ? { protectedBranchPatterns } : {}),
    ...(testAgentId ? { testAgentId } : {}),
  };
}

/** Default ON. Missing settings keep the gate closed. */
export function resolveAgentPrPolicy(
  settings?: { agentPrPolicy?: AgentPrPolicySettings } | null,
): ResolvedAgentPrPolicy {
  const raw = settings?.agentPrPolicy;
  return {
    enabled: raw?.enabled !== false,
    protectedBranchPatterns:
      raw?.protectedBranchPatterns && raw.protectedBranchPatterns.length > 0
        ? raw.protectedBranchPatterns
        : [...DEFAULT_PROTECTED_BRANCH_PATTERNS],
    testAgentId: raw?.testAgentId?.trim() || null,
  };
}

export function normalizeGithubToolName(toolName: string): string {
  return toolName.trim().toLowerCase().replace(/-/g, '_');
}

function endsWithCanonical(normalizedName: string, canonical: string): boolean {
  const c = canonical.toLowerCase();
  return normalizedName === c || normalizedName.endsWith(`_${c}`);
}

export function classifyGithubTool(toolName: string): GithubToolClass {
  const n = normalizeGithubToolName(toolName);

  if (endsWithCanonical(n, 'merge_pull_request')) return 'merge';
  if (
    endsWithCanonical(n, 'mark_pull_request_ready') ||
    endsWithCanonical(n, 'mark_ready_for_review') ||
    endsWithCanonical(n, 'ready_for_review')
  ) {
    return 'mark_ready';
  }
  if (endsWithCanonical(n, 'create_pull_request')) return 'create_pr';
  if (endsWithCanonical(n, 'update_pull_request_branch')) return 'other';
  if (endsWithCanonical(n, 'update_pull_request')) return 'update_pr';

  if (
    endsWithCanonical(n, 'create_or_update_file') ||
    endsWithCanonical(n, 'push_files') ||
    endsWithCanonical(n, 'delete_file')
  ) {
    return 'file_write';
  }

  if (endsWithCanonical(n, 'create_branch')) return 'create_branch';
  if (endsWithCanonical(n, 'delete_branch')) return 'delete_branch';

  if (
    endsWithCanonical(n, 'update_ref') ||
    endsWithCanonical(n, 'git_update_ref') ||
    endsWithCanonical(n, 'create_ref') ||
    endsWithCanonical(n, 'git_create_ref') ||
    endsWithCanonical(n, 'delete_ref') ||
    endsWithCanonical(n, 'git_delete_ref')
  ) {
    return endsWithCanonical(n, 'delete_ref') || endsWithCanonical(n, 'git_delete_ref')
      ? 'delete_branch'
      : 'ref_update';
  }

  const isRead = n.includes('get_') || n.includes('list_') || n.includes('search_');
  if (
    (!isRead && n.includes('ruleset')) ||
    endsWithCanonical(n, 'update_repository') ||
    (n.includes('default_branch') && (n.includes('set') || n.includes('update')))
  ) {
    return 'repo_settings';
  }

  return 'other';
}

export function extractWriteBranch(args: Record<string, unknown>): string | undefined {
  for (const key of ['branch', 'ref', 'target_branch', 'target']) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) {
      return normalizeBranchName(value);
    }
  }
  return undefined;
}

function isExplicitlyFalse(value: unknown): boolean {
  return value === false || value === 'false' || value === 0 || value === '0';
}

function isProtectedTarget(
  branch: string | undefined,
  policy: ResolvedAgentPrPolicy,
  defaultBranch?: string | null,
): { protected: boolean; label: string } {
  if (!branch) {
    return { protected: true, label: defaultBranch?.trim() || 'the repository default branch' };
  }
  if (matchProtectedBranch(branch, policy.protectedBranchPatterns)) {
    return { protected: true, label: branch };
  }
  const resolvedDefault = defaultBranch?.trim();
  if (resolvedDefault && normalizeBranchName(branch) === normalizeBranchName(resolvedDefault)) {
    return { protected: true, label: branch };
  }
  return { protected: false, label: branch };
}

export function evaluateGithubAgentPrPolicy(input: {
  toolName: string;
  args?: Record<string, unknown> | null;
  policy: ResolvedAgentPrPolicy;
  defaultBranch?: string | null;
}): GithubPolicyDecision {
  if (!input.policy.enabled) return { action: 'allow' };

  const args = input.args && typeof input.args === 'object' ? input.args : {};
  const kind = classifyGithubTool(input.toolName);

  switch (kind) {
    case 'create_pr':
      return { action: 'force_draft', patchedArgs: { ...args, draft: true } };
    case 'merge':
      return {
        action: 'block',
        code: 'merge_blocked',
        reason:
          'Agent PR policy blocks merge_pull_request. Leave the PR as a draft; a human squash-merges after the Test gate.',
      };
    case 'mark_ready':
      return {
        action: 'block',
        code: 'ready_for_review_blocked',
        reason:
          'Agent PR policy blocks marking a pull request ready for review. PRs must stay draft until a human merges.',
      };
    case 'update_pr':
      if (isExplicitlyFalse(args.draft) || isExplicitlyFalse(args.is_draft)) {
        return {
          action: 'block',
          code: 'ready_for_review_blocked',
          reason:
            'Agent PR policy blocks draft:false on update_pull_request. PRs must stay draft until a human merges.',
        };
      }
      return { action: 'allow' };
    case 'file_write':
    case 'create_branch':
    case 'ref_update': {
      const branch = extractWriteBranch(args);
      const target = isProtectedTarget(branch, input.policy, input.defaultBranch);
      if (target.protected) {
        return {
          action: 'block',
          code: 'protected_branch_write',
          reason: `Agent PR policy blocks writes to ${target.label}. Push to a feature branch and open a draft PR instead.`,
        };
      }
      return { action: 'allow' };
    }
    case 'delete_branch': {
      const branch = extractWriteBranch(args);
      const target = isProtectedTarget(branch, input.policy, input.defaultBranch);
      if (target.protected) {
        return {
          action: 'block',
          code: 'protected_branch_delete',
          reason: `Agent PR policy blocks deleting protected branch ${target.label}.`,
        };
      }
      return { action: 'allow' };
    }
    case 'repo_settings':
      return {
        action: 'block',
        code: 'repo_settings_blocked',
        reason:
          'Agent PR policy blocks changing repository settings or rulesets. Ask the Board to change those.',
      };
    default:
      return { action: 'allow' };
  }
}

export function extractPullRequestUrl(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const record = result as Record<string, unknown>;

  if (typeof record.html_url === 'string' && record.html_url.includes('/pull')) {
    return record.html_url;
  }
  if (typeof record.url === 'string' && /\/pulls?\/\d+/.test(record.url)) {
    return record.url;
  }
  if (record.pull_request && typeof record.pull_request === 'object') {
    const nested = extractPullRequestUrl(record.pull_request);
    if (nested) return nested;
  }
  if (typeof record.text === 'string') {
    const fromText = extractPullRequestUrlFromText(record.text);
    if (fromText) return fromText;
  }
  if (Array.isArray(record.content)) {
    for (const item of record.content) {
      const nested = extractPullRequestUrl(item);
      if (nested) return nested;
    }
  }
  return undefined;
}

function extractPullRequestUrlFromText(text: string): string | undefined {
  const href = text.match(/https?:\/\/[^\s)"']+\/pull\/\d+/);
  if (href) return href[0];
  try {
    return extractPullRequestUrl(JSON.parse(text));
  } catch {
    return undefined;
  }
}

export function buildAgentPrTestIssueTitle(prTitle?: string | null): string {
  const title = prTitle?.trim();
  return title ? `Test gate: ${title}` : 'Test gate: agent pull request';
}

export function buildAgentPrTestIssueDescription(input: {
  prUrl?: string | null;
  prTitle?: string | null;
  openedByAgentName?: string | null;
}): string {
  const prLine = input.prUrl?.trim()
    ? `**PR:** ${input.prUrl.trim()}`
    : '**PR:** (URL missing from the GitHub tool result — look up the latest draft PR)';
  const opener = input.openedByAgentName?.trim()
    ? `Opened by agent **${input.openedByAgentName.trim()}**.`
    : 'Opened by an agent.';

  return [
    '## Agent PR test gate',
    '',
    'An agent opened a **draft** pull request. Verify it — do **not** merge. A human squash-merges after this gate.',
    '',
    prLine,
    '',
    opener,
    '',
    '### Checklist',
    '- [ ] CI / automated tests pass',
    '- [ ] Acceptance criteria from the parent issue are met',
    '- [ ] No writes landed on a protected branch (main / master / release/*)',
    '- [ ] PR remains draft until a human is ready to squash-merge',
    '- [ ] Comment pass/fail on this issue',
    '',
    'Human merges. Agents must not mark the PR ready or call merge_pull_request.',
  ].join('\n');
}
