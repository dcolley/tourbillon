import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  CONTROL_PLANE_TOOL_IDS,
  evaluateToolName,
  isBrowserOrComputerToolName,
  isMcpToolNameAllowed,
  mcpServerToolNamespace,
  mcpToolNameMatchesPattern,
  owningMcpNamespace,
  resolveAllowedToolNames,
  resolveMcpToolPolicy,
  toolKeyForId,
} from '../tool-permissions';

const SEARCH_ENV = ['SEARXNG_URL', 'SEARXNG_BASE_URL', 'TAVILY_API_KEY', 'SEARXNG_API_KEY'];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of SEARCH_ENV) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});
afterEach(() => {
  for (const key of SEARCH_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

const engineer = { role: 'engineer', assignedToolsets: [] as string[], runtimeConfig: {} };

describe('resolveAllowedToolNames', () => {
  it('always allows control-plane tools by id and record key, in a stable order', () => {
    const allowed = resolveAllowedToolNames(engineer, null);
    assert.deepEqual(allowed.staticToolIds.slice(0, CONTROL_PLANE_TOOL_IDS.length), [...CONTROL_PLANE_TOOL_IDS]);
    assert.ok(allowed.staticNames.has('getInbox'));
    assert.ok(allowed.staticNames.has('getInboxTool'));
  });

  it('adds boolean toolset tools and role-default assignable tools', () => {
    const allowed = resolveAllowedToolNames({ ...engineer, assignedToolsets: ['roster', 'approvals'] }, null);
    for (const id of ['listAgents', 'createAgent', 'createApproval', 'listApprovals', 'getApproval', 'createIssue']) {
      assert.ok(allowed.staticNames.has(toolKeyForId(id)), id);
    }
    assert.ok(!allowed.staticNames.has('createGoalTool'), 'engineer default has no createGoal');
  });

  it('a toolset not assigned is excluded with not_in_toolset', () => {
    const allowed = resolveAllowedToolNames(engineer, null);
    assert.deepEqual(evaluateToolName(allowed, 'createAgentTool', 'heartbeat'), {
      allowed: false,
      reason: 'not_in_toolset',
    });
  });

  it('sendToAgent is excluded when mail is disabled', () => {
    const allowed = resolveAllowedToolNames({ ...engineer, runtimeConfig: { mail: { enabled: false } } }, null);
    assert.ok(!allowed.staticNames.has('sendToAgentTool'));
    assert.deepEqual(evaluateToolName(allowed, ['sendToAgentTool', 'sendToAgent'], 'heartbeat'), {
      allowed: false,
      reason: 'mail_disabled',
    });
    assert.ok(resolveAllowedToolNames(engineer, null).staticNames.has('sendToAgentTool'), 'mail on by default');
  });

  it('web search tools need configuration even with the toolset', () => {
    const agent = { ...engineer, assignedToolsets: ['web-search', 'web-search-tavily'] };
    const off = resolveAllowedToolNames(agent, { settings: {} });
    assert.deepEqual(evaluateToolName(off, 'searxngSearchTool', 'heartbeat'), {
      allowed: false,
      reason: 'web_search_not_configured',
    });
    assert.deepEqual(evaluateToolName(off, 'webSearchTavilyTool', 'heartbeat'), {
      allowed: false,
      reason: 'web_search_not_configured',
    });
    const on = resolveAllowedToolNames(agent, {
      settings: { searxngUrl: 'http://searxng.local', tavilyApiKey: 'tvly-test' } as never,
    });
    assert.equal(evaluateToolName(on, 'searxngSearchTool', 'heartbeat').allowed, true);
    assert.equal(evaluateToolName(on, 'webSearchTavily', 'heartbeat').allowed, true);
  });

  it('workspace tools only with the code-execution toolset', () => {
    const off = resolveAllowedToolNames(engineer, null);
    assert.equal(evaluateToolName(off, 'mastra_workspace_execute_command', 'harness').allowed, false);
    const on = resolveAllowedToolNames({ ...engineer, assignedToolsets: ['code-execution'] }, null);
    assert.equal(evaluateToolName(on, 'mastra_workspace_execute_command', 'harness').allowed, true);
  });

  it('controller task tools on controller surfaces only; memory tools everywhere', () => {
    const allowed = resolveAllowedToolNames(engineer, null);
    assert.equal(evaluateToolName(allowed, 'task_write', 'harness').allowed, true);
    assert.equal(evaluateToolName(allowed, 'task_write', 'chat').allowed, true);
    assert.equal(evaluateToolName(allowed, 'task_write', 'heartbeat').allowed, false);
    assert.equal(evaluateToolName(allowed, 'updateWorkingMemory', 'heartbeat').allowed, true);
  });

  it('unknown names are not allowed', () => {
    const allowed = resolveAllowedToolNames(engineer, null);
    assert.deepEqual(evaluateToolName(allowed, 'inventedTool', 'chat'), { allowed: false, reason: 'not_allowed' });
    assert.deepEqual(evaluateToolName(allowed, [], 'chat'), { allowed: false, reason: 'not_allowed' });
  });

  it('browser / computer tools are denied by default, even next to an allowed name', () => {
    const allowed = resolveAllowedToolNames(engineer, null);
    for (const name of ['browser_navigate', 'computer_click', 'mastra_browser', 'takeover']) {
      assert.ok(isBrowserOrComputerToolName(name), name);
      assert.deepEqual(evaluateToolName(allowed, name, 'harness'), { allowed: false, reason: 'browser_tools_disabled' });
    }
    assert.deepEqual(evaluateToolName(allowed, ['getInboxTool', 'browser_open'], 'heartbeat'), {
      allowed: false,
      reason: 'browser_tools_disabled',
    });
    assert.ok(!isBrowserOrComputerToolName('getInboxTool'));
  });
});

describe('MCP allow-list', () => {
  const filesystem = { id: 'filesystem-local' };
  const github = { id: 'github-mcp', toolBlacklist: ['delete_repository'] };

  it('namespaces match MCP client tool prefixes', () => {
    assert.equal(mcpServerToolNamespace('filesystem-local'), 'filesystem');
    assert.equal(mcpServerToolNamespace('memory-mcp-private'), 'memory_private');
    assert.equal(mcpServerToolNamespace('memory-mcp'), 'memory_private');
    assert.equal(mcpServerToolNamespace('memory-mcp-company'), 'memory_company');
    assert.equal(mcpServerToolNamespace('github-mcp'), 'github');
    assert.equal(mcpServerToolNamespace('my-http-server'), 'my_http_server');
  });

  it('allows tools of allowed servers that pass the policy', () => {
    const allowed = resolveAllowedToolNames(engineer, null, { mcpServers: [filesystem, github] });
    assert.deepEqual(evaluateToolName(allowed, 'filesystem_read_file', 'heartbeat'), { allowed: true, category: 'mcp' });
    assert.deepEqual(evaluateToolName(allowed, 'github_create_issue', 'chat'), { allowed: true, category: 'mcp' });
  });

  it('registry blacklist and agent deny policy deny by name', () => {
    const agent = { ...engineer, runtimeConfig: { mcpToolPolicy: { 'filesystem-local': { deny: ['write_file'] } } } };
    const allowed = resolveAllowedToolNames(agent, null, { mcpServers: [filesystem, github] });
    assert.deepEqual(evaluateToolName(allowed, 'filesystem_write_file', 'heartbeat'), {
      allowed: false,
      reason: 'mcp_policy_denied',
    });
    assert.deepEqual(evaluateToolName(allowed, 'github_delete_repository', 'heartbeat'), {
      allowed: false,
      reason: 'mcp_policy_denied',
    });
    assert.equal(evaluateToolName(allowed, 'filesystem_read_file', 'heartbeat').allowed, true);
  });

  it('agent allow policy narrows a server; empty allow allows none', () => {
    const agent = { ...engineer, runtimeConfig: { mcpToolPolicy: { 'filesystem-local': { allow: ['read_file'] } } } };
    const allowed = resolveAllowedToolNames(agent, null, { mcpServers: [filesystem] });
    assert.equal(evaluateToolName(allowed, 'filesystem_read_file', 'heartbeat').allowed, true);
    assert.equal(evaluateToolName(allowed, 'filesystem_list_directory', 'heartbeat').allowed, false);
    assert.equal(isMcpToolNameAllowed('filesystem_read_file', { deny: [], allow: [] }), false);
  });

  it('legacy memory-mcp policy applies to the private memory server', () => {
    const policy = resolveMcpToolPolicy(
      { id: 'memory-mcp-private' },
      { mcpToolPolicy: { 'memory-mcp': { deny: ['delete_entities'] } } } as never,
    );
    assert.deepEqual(policy.deny, ['delete_entities']);
  });

  it('policy patterns match the exact tool name only (no prefix, suffix or substring)', () => {
    const buffer = { id: 'buffer-mcp', toolWhitelist: ['get_post', 'buffer_list_posts'], toolBlacklist: ['post'] };
    const policy = resolveMcpToolPolicy(buffer);
    assert.equal(policy.namespace, 'buffer');
    // Bare name under the server namespace, or the full exposed name.
    assert.equal(isMcpToolNameAllowed('buffer_get_post', policy), true);
    assert.equal(isMcpToolNameAllowed('buffer_list_posts', policy), true);
    // Old substring / suffix matches no longer count.
    assert.equal(isMcpToolNameAllowed('buffer_get_post_metrics', policy), false, 'whitelist is not a prefix');
    assert.equal(isMcpToolNameAllowed('buffer_admin_get_post', policy), false, 'whitelist is not a suffix');
    assert.equal(mcpToolNameMatchesPattern('buffer_get_post', 'post', 'buffer'), false, 'blacklist is not a substring');
    assert.equal(mcpToolNameMatchesPattern('buffer_get_post', 'get_post', 'other'), false, 'namespace must match');
    assert.equal(mcpToolNameMatchesPattern('buffer_get_post', '', 'buffer'), false);
    const deny = resolveMcpToolPolicy({ id: 'buffer-mcp', toolBlacklist: ['delete_post'] });
    assert.equal(isMcpToolNameAllowed('buffer_delete_post', deny), false);
    assert.equal(isMcpToolNameAllowed('buffer_delete_post_draft', deny), true);
  });

  it('a server namespace never claims tools of a server whose namespace extends it (collision)', () => {
    assert.equal(owningMcpNamespace('acme_admin_drop_all', ['acme', 'acme_admin']), 'acme_admin');
    assert.equal(owningMcpNamespace('acme_admin_drop_all', ['acme_admin', 'acme']), 'acme_admin');
    assert.equal(owningMcpNamespace('acme_list', ['acme', 'acme_admin']), 'acme');
    assert.equal(owningMcpNamespace('acmex_list', ['acme']), null);
    assert.equal(owningMcpNamespace('acme_', ['acme']), null);

    // Only `acme-mcp` is allowed; `acme-admin-mcp` is registered but not allowed.
    const allowed = resolveAllowedToolNames(engineer, null, {
      mcpServers: [{ id: 'acme-mcp' }],
      knownMcpServerIds: ['acme-mcp', 'acme-admin-mcp'],
    });
    assert.deepEqual(evaluateToolName(allowed, 'acme_list', 'heartbeat'), { allowed: true, category: 'mcp' });
    assert.deepEqual(evaluateToolName(allowed, 'acme_admin_drop_all', 'heartbeat'), {
      allowed: false,
      reason: 'not_allowed',
    });

    // Policy patterns are scoped to the owning server's namespace too.
    const narrowed = resolveAllowedToolNames(
      { ...engineer, runtimeConfig: { mcpToolPolicy: { 'acme-mcp': { allow: ['list'] } } } },
      null,
      { mcpServers: [{ id: 'acme-mcp' }, { id: 'acme-admin-mcp' }], knownMcpServerIds: ['acme-mcp', 'acme-admin-mcp'] },
    );
    assert.equal(evaluateToolName(narrowed, 'acme_list', 'heartbeat').allowed, true);
    assert.equal(evaluateToolName(narrowed, 'acme_admin_list', 'heartbeat').allowed, true, 'admin server has no policy');
    assert.deepEqual(evaluateToolName(narrowed, 'acme_admin_drop_all', 'heartbeat'), { allowed: true, category: 'mcp' });
    assert.deepEqual(evaluateToolName(narrowed, 'acme_drop_all', 'heartbeat'), { allowed: false, reason: 'mcp_policy_denied' });
  });

  it('tools of servers not passed in are not allowed', () => {
    const allowed = resolveAllowedToolNames(engineer, null, { mcpServers: [github] });
    assert.deepEqual(evaluateToolName(allowed, 'filesystem_write_file', 'heartbeat'), {
      allowed: false,
      reason: 'not_allowed',
    });
  });
});
