import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { wrapGithubMcpTools, type GithubPolicyWrapContext } from './github-pr-policy';

function makeTool(execute: (input: unknown, ctx?: unknown) => Promise<unknown> | unknown) {
  return {
    id: 'tool',
    description: 'test',
    execute,
  };
}

function wrapContext(
  overrides: Partial<GithubPolicyWrapContext> = {},
): GithubPolicyWrapContext {
  return {
    companyId: 'co-1',
    agentId: 'ag-1',
    agentName: 'Engineer',
    companySettings: { agentPrPolicy: { enabled: true } },
    logBlocked: async () => undefined,
    afterPullRequestCreated: async () => undefined,
    resolveDefaultBranch: async () => null,
    ...overrides,
  };
}

describe('wrapGithubMcpTools', () => {
  it('forces draft:true on create_pull_request when the agent sends draft:false', async () => {
    let seen: Record<string, unknown> | null = null;
    const tools = wrapGithubMcpTools(
      {
        create_pull_request: makeTool(async (input) => {
          seen = input as Record<string, unknown>;
          return { html_url: 'https://github.com/acme/app/pull/9', draft: true };
        }),
      },
      wrapContext(),
    );

    const tool = tools.create_pull_request as { execute: (i: unknown) => Promise<unknown> };
    const result = await tool.execute({ title: 'feat', draft: false, head: 'feat/x', base: 'main' });

    assert.equal(seen?.draft, true);
    assert.equal((result as { html_url: string }).html_url, 'https://github.com/acme/app/pull/9');
  });

  it('creates an Auto Test issue after a successful agent PR', async () => {
    let opened: { result: unknown } | null = null;
    const tools = wrapGithubMcpTools(
      {
        create_pull_request: makeTool(async () => ({
          html_url: 'https://github.com/acme/app/pull/3',
        })),
      },
      wrapContext({
        afterPullRequestCreated: async (event) => {
          opened = { result: event.result };
        },
      }),
    );

    const tool = tools.create_pull_request as { execute: (i: unknown) => Promise<unknown> };
    await tool.execute({ title: 'feat', draft: false });
    assert.ok(opened);
    assert.equal(
      (opened.result as { html_url: string }).html_url,
      'https://github.com/acme/app/pull/3',
    );
  });

  it('blocks merge and writes activity', async () => {
    const blocked: string[] = [];
    let called = false;
    const tools = wrapGithubMcpTools(
      {
        merge_pull_request: makeTool(async () => {
          called = true;
          return { merged: true };
        }),
      },
      wrapContext({
        logBlocked: async (event) => {
          blocked.push(event.code);
        },
      }),
    );

    const tool = tools.merge_pull_request as { execute: (i: unknown) => Promise<unknown> };
    const result = (await tool.execute({ pull_number: 1 })) as {
      error?: string;
      code?: string;
      message?: string;
    };

    assert.equal(called, false);
    assert.equal(result.error, 'github_policy_blocked');
    assert.equal(result.code, 'merge_blocked');
    assert.match(result.message ?? '', /draft/i);
    assert.deepEqual(blocked, ['merge_blocked']);
  });

  it('blocks ready-for-review, push to main, and file write to main', async () => {
    const blocked: string[] = [];
    const ctx = wrapContext({
      logBlocked: async (event) => {
        blocked.push(`${event.toolName}:${event.code}`);
      },
    });

    const tools = wrapGithubMcpTools(
      {
        update_pull_request: makeTool(async () => ({ ok: true })),
        push_files: makeTool(async () => ({ ok: true })),
        create_or_update_file: makeTool(async () => ({ ok: true })),
      },
      ctx,
    );

    const ready = (await (
      tools.update_pull_request as { execute: (i: unknown) => Promise<unknown> }
    ).execute({ draft: false })) as { code?: string };
    const push = (await (
      tools.push_files as { execute: (i: unknown) => Promise<unknown> }
    ).execute({ branch: 'main' })) as { code?: string };
    const write = (await (
      tools.create_or_update_file as { execute: (i: unknown) => Promise<unknown> }
    ).execute({ branch: 'main', path: 'a.ts' })) as { code?: string };

    assert.equal(ready.code, 'ready_for_review_blocked');
    assert.equal(push.code, 'protected_branch_write');
    assert.equal(write.code, 'protected_branch_write');
    assert.equal(blocked.length, 3);
  });

  it('allows push to a feature branch', async () => {
    let called = false;
    const tools = wrapGithubMcpTools(
      {
        push_files: makeTool(async (input) => {
          called = true;
          return { branch: (input as { branch: string }).branch };
        }),
      },
      wrapContext(),
    );

    const result = await (
      tools.push_files as { execute: (i: unknown) => Promise<unknown> }
    ).execute({ branch: 'feat/ok' });
    assert.equal(called, true);
    assert.equal((result as { branch: string }).branch, 'feat/ok');
  });

  it('does not wrap when the Board turns the policy off', async () => {
    let merged = false;
    const tools = wrapGithubMcpTools(
      {
        merge_pull_request: makeTool(async () => {
          merged = true;
          return { merged: true };
        }),
      },
      wrapContext({
        companySettings: { agentPrPolicy: { enabled: false } },
      }),
    );

    const result = await (
      tools.merge_pull_request as { execute: (i: unknown) => Promise<unknown> }
    ).execute({});
    assert.equal(merged, true);
    assert.equal((result as { merged: boolean }).merged, true);
  });
});
