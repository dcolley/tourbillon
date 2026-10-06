import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  classifyGithubTool,
  DEFAULT_PROTECTED_BRANCH_PATTERNS,
  evaluateGithubAgentPrPolicy,
  extractPullRequestUrl,
  extractWriteBranch,
  matchBranchPattern,
  matchProtectedBranch,
  normalizeBranchName,
  parseAgentPrPolicySettings,
  parseProtectedBranchPatterns,
  resolveAgentPrPolicy,
  type ResolvedAgentPrPolicy,
} from './agent-pr-policy';

const enabledPolicy: ResolvedAgentPrPolicy = {
  enabled: true,
  protectedBranchPatterns: [...DEFAULT_PROTECTED_BRANCH_PATTERNS],
  testAgentId: null,
};

describe('normalizeBranchName', () => {
  it('strips refs/heads/ and origin/', () => {
    assert.equal(normalizeBranchName('refs/heads/main'), 'main');
    assert.equal(normalizeBranchName('origin/release/1.0'), 'release/1.0');
    assert.equal(normalizeBranchName('  feature/foo  '), 'feature/foo');
  });
});

describe('matchBranchPattern / matchProtectedBranch', () => {
  it('matches exact names', () => {
    assert.equal(matchProtectedBranch('main', DEFAULT_PROTECTED_BRANCH_PATTERNS), true);
    assert.equal(matchProtectedBranch('master', DEFAULT_PROTECTED_BRANCH_PATTERNS), true);
    assert.equal(matchProtectedBranch('develop', DEFAULT_PROTECTED_BRANCH_PATTERNS), false);
    assert.equal(matchProtectedBranch('feature/main', DEFAULT_PROTECTED_BRANCH_PATTERNS), false);
  });

  it('matches release/* one segment only', () => {
    assert.equal(matchProtectedBranch('release/1.0', DEFAULT_PROTECTED_BRANCH_PATTERNS), true);
    assert.equal(matchProtectedBranch('release/hotfix', DEFAULT_PROTECTED_BRANCH_PATTERNS), true);
    assert.equal(matchProtectedBranch('release', DEFAULT_PROTECTED_BRANCH_PATTERNS), false);
    assert.equal(matchProtectedBranch('releases/1.0', DEFAULT_PROTECTED_BRANCH_PATTERNS), false);
    assert.equal(matchProtectedBranch('release/1.0/beta', DEFAULT_PROTECTED_BRANCH_PATTERNS), false);
  });

  it('normalizes refs before matching release/*', () => {
    assert.equal(
      matchProtectedBranch('refs/heads/release/2.4', DEFAULT_PROTECTED_BRANCH_PATTERNS),
      true,
    );
    assert.equal(matchProtectedBranch('origin/main', DEFAULT_PROTECTED_BRANCH_PATTERNS), true);
  });

  it('supports ** across slashes', () => {
    assert.equal(matchBranchPattern('release/1.0/beta', 'release/**'), true);
    assert.equal(matchBranchPattern('release/1.0', 'release/**'), true);
  });

  it('uses a custom pattern list', () => {
    assert.equal(matchProtectedBranch('develop', ['develop', 'release/*']), true);
    assert.equal(matchProtectedBranch('main', ['develop']), false);
  });
});

describe('parse / resolve Agent PR policy', () => {
  it('defaults to ON with built-in protected patterns', () => {
    const resolved = resolveAgentPrPolicy({});
    assert.equal(resolved.enabled, true);
    assert.deepEqual(resolved.protectedBranchPatterns, [...DEFAULT_PROTECTED_BRANCH_PATTERNS]);
    assert.equal(resolved.testAgentId, null);
  });

  it('treats missing settings as ON', () => {
    assert.equal(resolveAgentPrPolicy(null).enabled, true);
    assert.equal(resolveAgentPrPolicy(undefined).enabled, true);
  });

  it('honors enabled:false', () => {
    const parsed = parseAgentPrPolicySettings({ enabled: false, testAgentId: ' agent-1 ' });
    assert.equal(parsed?.enabled, false);
    assert.equal(parsed?.testAgentId, 'agent-1');
    assert.equal(resolveAgentPrPolicy({ agentPrPolicy: parsed }).enabled, false);
  });

  it('parses comma and newline pattern lists', () => {
    assert.deepEqual(parseProtectedBranchPatterns('main, develop\nrelease/*'), [
      'main',
      'develop',
      'release/*',
    ]);
  });
});

describe('classifyGithubTool', () => {
  it('classifies canonical and prefixed names', () => {
    assert.equal(classifyGithubTool('create_pull_request'), 'create_pr');
    assert.equal(classifyGithubTool('github_create_pull_request'), 'create_pr');
    assert.equal(classifyGithubTool('merge_pull_request'), 'merge');
    assert.equal(classifyGithubTool('update_pull_request'), 'update_pr');
    assert.equal(classifyGithubTool('update_pull_request_branch'), 'other');
    assert.equal(classifyGithubTool('create_or_update_file'), 'file_write');
    assert.equal(classifyGithubTool('push_files'), 'file_write');
    assert.equal(classifyGithubTool('delete_file'), 'file_write');
    assert.equal(classifyGithubTool('create_branch'), 'create_branch');
    assert.equal(classifyGithubTool('delete_branch'), 'delete_branch');
    assert.equal(classifyGithubTool('update_repository'), 'repo_settings');
    assert.equal(classifyGithubTool('create_or_update_repository_ruleset'), 'repo_settings');
    assert.equal(classifyGithubTool('list_repository_rulesets'), 'other');
    assert.equal(classifyGithubTool('get_file_contents'), 'other');
  });
});

describe('evaluateGithubAgentPrPolicy', () => {
  it('forces draft:true on create_pull_request even when the agent asks for false', () => {
    const decision = evaluateGithubAgentPrPolicy({
      toolName: 'create_pull_request',
      args: { title: 'feat', draft: false, base: 'main', head: 'feat/x' },
      policy: enabledPolicy,
    });
    assert.equal(decision.action, 'force_draft');
    if (decision.action === 'force_draft') {
      assert.equal(decision.patchedArgs.draft, true);
      assert.equal(decision.patchedArgs.base, 'main');
    }
  });

  it('blocks merge_pull_request', () => {
    const decision = evaluateGithubAgentPrPolicy({
      toolName: 'merge_pull_request',
      args: { pull_number: 1, merge_method: 'squash' },
      policy: enabledPolicy,
    });
    assert.equal(decision.action, 'block');
    if (decision.action === 'block') assert.equal(decision.code, 'merge_blocked');
  });

  it('blocks marking a PR ready via draft:false', () => {
    const decision = evaluateGithubAgentPrPolicy({
      toolName: 'update_pull_request',
      args: { pull_number: 1, draft: false },
      policy: enabledPolicy,
    });
    assert.equal(decision.action, 'block');
    if (decision.action === 'block') assert.equal(decision.code, 'ready_for_review_blocked');
  });

  it('allows update_pull_request title edits while staying draft', () => {
    const decision = evaluateGithubAgentPrPolicy({
      toolName: 'update_pull_request',
      args: { pull_number: 1, title: 'nits' },
      policy: enabledPolicy,
    });
    assert.equal(decision.action, 'allow');
  });

  it('blocks file write and push to main', () => {
    const fileWrite = evaluateGithubAgentPrPolicy({
      toolName: 'create_or_update_file',
      args: { path: 'README.md', branch: 'main' },
      policy: enabledPolicy,
    });
    assert.equal(fileWrite.action, 'block');
    if (fileWrite.action === 'block') assert.equal(fileWrite.code, 'protected_branch_write');

    const push = evaluateGithubAgentPrPolicy({
      toolName: 'push_files',
      args: { branch: 'refs/heads/main' },
      policy: enabledPolicy,
    });
    assert.equal(push.action, 'block');
  });

  it('blocks write with no branch (implicit default) and defaultBranch develop', () => {
    const omitted = evaluateGithubAgentPrPolicy({
      toolName: 'create_or_update_file',
      args: { path: 'a.ts' },
      policy: enabledPolicy,
    });
    assert.equal(omitted.action, 'block');

    const develop = evaluateGithubAgentPrPolicy({
      toolName: 'push_files',
      args: { branch: 'develop' },
      policy: enabledPolicy,
      defaultBranch: 'develop',
    });
    assert.equal(develop.action, 'block');
  });

  it('allows push and file write to a feature branch', () => {
    const push = evaluateGithubAgentPrPolicy({
      toolName: 'push_files',
      args: { branch: 'feat/agent-pr-policy' },
      policy: enabledPolicy,
    });
    assert.equal(push.action, 'allow');

    const fileWrite = evaluateGithubAgentPrPolicy({
      toolName: 'create_or_update_file',
      args: { branch: 'feat/agent-pr-policy', path: 'x.ts' },
      policy: enabledPolicy,
    });
    assert.equal(fileWrite.action, 'allow');
  });

  it('blocks writes to release/* and deleting a protected branch', () => {
    const releaseWrite = evaluateGithubAgentPrPolicy({
      toolName: 'push_files',
      args: { branch: 'release/1.4' },
      policy: enabledPolicy,
    });
    assert.equal(releaseWrite.action, 'block');

    const deleteMain = evaluateGithubAgentPrPolicy({
      toolName: 'delete_branch',
      args: { branch: 'main' },
      policy: enabledPolicy,
    });
    assert.equal(deleteMain.action, 'block');
    if (deleteMain.action === 'block') assert.equal(deleteMain.code, 'protected_branch_delete');

    const deleteFeat = evaluateGithubAgentPrPolicy({
      toolName: 'delete_branch',
      args: { branch: 'feat/tmp' },
      policy: enabledPolicy,
    });
    assert.equal(deleteFeat.action, 'allow');
  });

  it('blocks repo settings and ruleset writes', () => {
    const settings = evaluateGithubAgentPrPolicy({
      toolName: 'update_repository',
      args: { description: 'nope' },
      policy: enabledPolicy,
    });
    assert.equal(settings.action, 'block');
    if (settings.action === 'block') assert.equal(settings.code, 'repo_settings_blocked');

    const ruleset = evaluateGithubAgentPrPolicy({
      toolName: 'create_or_update_repository_ruleset',
      args: {},
      policy: enabledPolicy,
    });
    assert.equal(ruleset.action, 'block');
  });

  it('lifts all blocks when the Board turns the policy off', () => {
    const off: ResolvedAgentPrPolicy = {
      enabled: false,
      protectedBranchPatterns: [...DEFAULT_PROTECTED_BRANCH_PATTERNS],
      testAgentId: null,
    };
    assert.equal(
      evaluateGithubAgentPrPolicy({
        toolName: 'merge_pull_request',
        args: {},
        policy: off,
      }).action,
      'allow',
    );
    assert.equal(
      evaluateGithubAgentPrPolicy({
        toolName: 'create_or_update_file',
        args: { branch: 'main' },
        policy: off,
      }).action,
      'allow',
    );
    assert.equal(
      evaluateGithubAgentPrPolicy({
        toolName: 'create_pull_request',
        args: { draft: false },
        policy: off,
      }).action,
      'allow',
    );
  });

  it('extracts branch from ref-style args', () => {
    assert.equal(extractWriteBranch({ ref: 'refs/heads/main' }), 'main');
    assert.equal(extractWriteBranch({ branch: 'feat/x' }), 'feat/x');
  });
});

describe('extractPullRequestUrl', () => {
  it('reads html_url and MCP text content', () => {
    assert.equal(
      extractPullRequestUrl({ html_url: 'https://github.com/acme/app/pull/4' }),
      'https://github.com/acme/app/pull/4',
    );
    assert.equal(
      extractPullRequestUrl({
        content: [{ text: JSON.stringify({ html_url: 'https://github.com/acme/app/pull/8' }) }],
      }),
      'https://github.com/acme/app/pull/8',
    );
  });
});
