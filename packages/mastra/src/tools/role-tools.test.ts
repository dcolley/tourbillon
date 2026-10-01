import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { ROLE_TOOLS } from './role-tools';

describe('createAgentTool', () => {
  it('is defined and exported in rosterTools', () => {
    const rosterTools = ROLE_TOOLS['roster'];
    assert.ok(rosterTools, 'roster toolset exists');
    assert.ok('createAgentTool' in rosterTools, 'createAgentTool is in roster toolset');
    assert.ok('listAgentsTool' in rosterTools, 'listAgentsTool is in roster toolset');
    assert.ok('getAgentTool' in rosterTools, 'getAgentTool is in roster toolset');
  });

  it('agent-management is NOT an alias of roster', () => {
    const rosterTools = ROLE_TOOLS['roster'];
    const agentManagementTools = ROLE_TOOLS['agent-management'];
    assert.ok(rosterTools, 'roster toolset exists');
    assert.ok(agentManagementTools, 'agent-management toolset exists');
    assert.notEqual(
      rosterTools,
      agentManagementTools,
      'agent-management is not the same object as roster'
    );
    assert.ok(
      !('setAgentActiveTool' in rosterTools),
      'roster does not contain setAgentActiveTool'
    );
    assert.ok(
      'setAgentActiveTool' in agentManagementTools,
      'agent-management contains setAgentActiveTool'
    );
  });

  it('has correct tool metadata', () => {
    const rosterTools = ROLE_TOOLS['roster'] as Record<string, any>;
    const createAgentTool = rosterTools.createAgentTool;
    
    assert.equal(createAgentTool.id, 'createAgent', 'tool id is createAgent');
    assert.ok(createAgentTool.description, 'tool has description');
    assert.ok(
      createAgentTool.description.includes('board approval'),
      'description mentions board approval'
    );
  });

  it('validates required fields in schema', () => {
    const rosterTools = ROLE_TOOLS['roster'] as Record<string, any>;
    const createAgentTool = rosterTools.createAgentTool;
    const schema = createAgentTool.inputSchema;

    const validInput = {
      name: 'Sarah Chen',
      title: 'Chief Financial Officer',
      role: 'custom',
    };
    const result = schema.safeParse(validInput);
    assert.ok(result.success, 'valid input passes schema validation');
  });

  it('rejects missing required fields', () => {
    const rosterTools = ROLE_TOOLS['roster'] as Record<string, any>;
    const createAgentTool = rosterTools.createAgentTool;
    const schema = createAgentTool.inputSchema;

    const missingName = schema.safeParse({ title: 'CFO', role: 'custom' });
    assert.ok(!missingName.success, 'missing name fails validation');

    const missingTitle = schema.safeParse({ name: 'Sarah', role: 'custom' });
    assert.ok(!missingTitle.success, 'missing title fails validation');

    const missingRole = schema.safeParse({ name: 'Sarah', title: 'CFO' });
    assert.ok(!missingRole.success, 'missing role fails validation');
  });

  it('accepts optional fields', () => {
    const rosterTools = ROLE_TOOLS['roster'] as Record<string, any>;
    const createAgentTool = rosterTools.createAgentTool;
    const schema = createAgentTool.inputSchema;

    const withOptionals = {
      name: 'Sarah Chen',
      title: 'Chief Financial Officer',
      role: 'custom',
      urlKey: 'cfo',
      reportsToId: 'agent_123',
      runtimeType: 'agent' as const,
    };
    const result = schema.safeParse(withOptionals);
    assert.ok(result.success, 'optional fields pass validation');
  });

  it('validates role enum values', () => {
    const rosterTools = ROLE_TOOLS['roster'] as Record<string, any>;
    const createAgentTool = rosterTools.createAgentTool;
    const schema = createAgentTool.inputSchema;

    const validRoles = ['ceo', 'cto', 'engineer', 'pm', 'qa', 'designer', 'custom'];
    for (const role of validRoles) {
      const result = schema.safeParse({
        name: 'Test',
        title: 'Test',
        role,
      });
      assert.ok(result.success, `role ${role} is valid`);
    }

    const invalidRole = schema.safeParse({
      name: 'Test',
      title: 'Test',
      role: 'invalid',
    });
    assert.ok(!invalidRole.success, 'invalid role fails validation');
  });

  it('validates runtimeType enum values', () => {
    const rosterTools = ROLE_TOOLS['roster'] as Record<string, any>;
    const createAgentTool = rosterTools.createAgentTool;
    const schema = createAgentTool.inputSchema;

    const agent = schema.safeParse({
      name: 'Test',
      title: 'Test',
      role: 'engineer',
      runtimeType: 'agent',
    });
    assert.ok(agent.success, 'runtimeType agent is valid');

    const harness = schema.safeParse({
      name: 'Test',
      title: 'Test',
      role: 'engineer',
      runtimeType: 'harness',
    });
    assert.ok(harness.success, 'runtimeType harness is valid');

    const invalid = schema.safeParse({
      name: 'Test',
      title: 'Test',
      role: 'engineer',
      runtimeType: 'invalid',
    });
    assert.ok(!invalid.success, 'invalid runtimeType fails validation');
  });

  it('allows reportsToId to be null', () => {
    const rosterTools = ROLE_TOOLS['roster'] as Record<string, any>;
    const createAgentTool = rosterTools.createAgentTool;
    const schema = createAgentTool.inputSchema;

    const withNull = schema.safeParse({
      name: 'Test',
      title: 'Test',
      role: 'ceo',
      reportsToId: null,
    });
    assert.ok(withNull.success, 'reportsToId can be null');
  });
});

describe('agent-management tools', () => {
  it('contains setAgentActiveTool', () => {
    const tools = ROLE_TOOLS['agent-management'] as Record<string, any>;
    assert.ok(tools, 'agent-management toolset exists');
    assert.ok('setAgentActiveTool' in tools, 'setAgentActiveTool exists');
    const tool = tools.setAgentActiveTool;
    assert.equal(tool.id, 'setAgentActive', 'tool id is setAgentActive');
    assert.ok(tool.description, 'tool has description');
  });

  it('setAgentActive validates required fields', () => {
    const tools = ROLE_TOOLS['agent-management'] as Record<string, any>;
    const tool = tools.setAgentActiveTool;
    const schema = tool.inputSchema;

    const valid = schema.safeParse({
      agentId: 'agent_123',
      status: 'paused',
    });
    assert.ok(valid.success, 'valid input passes');

    const missingAgent = schema.safeParse({ status: 'active' });
    assert.ok(!missingAgent.success, 'missing agentId fails');

    const missingStatus = schema.safeParse({ agentId: 'agent_123' });
    assert.ok(!missingStatus.success, 'missing status fails');
  });

  it('setAgentActive validates status enum', () => {
    const tools = ROLE_TOOLS['agent-management'] as Record<string, any>;
    const tool = tools.setAgentActiveTool;
    const schema = tool.inputSchema;

    for (const status of ['active', 'paused', 'archived']) {
      const result = schema.safeParse({ agentId: 'agent_123', status });
      assert.ok(result.success, `status ${status} is valid`);
    }

    const invalid = schema.safeParse({ agentId: 'agent_123', status: 'invalid' });
    assert.ok(!invalid.success, 'invalid status fails');
  });

  it('contains setAgentHeartbeatTool', () => {
    const tools = ROLE_TOOLS['agent-management'] as Record<string, any>;
    assert.ok('setAgentHeartbeatTool' in tools, 'setAgentHeartbeatTool exists');
    const tool = tools.setAgentHeartbeatTool;
    assert.equal(tool.id, 'setAgentHeartbeat', 'tool id is setAgentHeartbeat');
  });

  it('setAgentHeartbeat validates required fields', () => {
    const tools = ROLE_TOOLS['agent-management'] as Record<string, any>;
    const tool = tools.setAgentHeartbeatTool;
    const schema = tool.inputSchema;

    const valid = schema.safeParse({
      agentId: 'agent_123',
      enabled: true,
    });
    assert.ok(valid.success, 'valid input passes');

    const missingAgent = schema.safeParse({ enabled: true });
    assert.ok(!missingAgent.success, 'missing agentId fails');

    const missingEnabled = schema.safeParse({ agentId: 'agent_123' });
    assert.ok(!missingEnabled.success, 'missing enabled fails');
  });

  it('contains updateAgentProfileTool', () => {
    const tools = ROLE_TOOLS['agent-management'] as Record<string, any>;
    assert.ok('updateAgentProfileTool' in tools, 'updateAgentProfileTool exists');
    const tool = tools.updateAgentProfileTool;
    assert.equal(tool.id, 'updateAgentProfile', 'tool id is updateAgentProfile');
  });

  it('contains updateAgentModelTool', () => {
    const tools = ROLE_TOOLS['agent-management'] as Record<string, any>;
    assert.ok('updateAgentModelTool' in tools, 'updateAgentModelTool exists');
    const tool = tools.updateAgentModelTool;
    assert.equal(tool.id, 'updateAgentModel', 'tool id is updateAgentModel');
  });

  it('updateAgentModel validates required fields', () => {
    const tools = ROLE_TOOLS['agent-management'] as Record<string, any>;
    const tool = tools.updateAgentModelTool;
    const schema = tool.inputSchema;

    const valid = schema.safeParse({
      agentId: 'agent_123',
      modelId: 'meta-llama/Llama-3.3-70B-Instruct',
    });
    assert.ok(valid.success, 'valid input passes');

    const missingAgent = schema.safeParse({ modelId: 'test' });
    assert.ok(!missingAgent.success, 'missing agentId fails');

    const missingModel = schema.safeParse({ agentId: 'agent_123' });
    assert.ok(!missingModel.success, 'missing modelId fails');
  });

  it('contains updateAgentCapabilitiesTool', () => {
    const tools = ROLE_TOOLS['agent-management'] as Record<string, any>;
    assert.ok('updateAgentCapabilitiesTool' in tools, 'updateAgentCapabilitiesTool exists');
    const tool = tools.updateAgentCapabilitiesTool;
    assert.equal(tool.id, 'updateAgentCapabilities', 'tool id is updateAgentCapabilities');
    assert.ok(
      tool.description.includes('reason'),
      'description mentions reason for escalation'
    );
  });

  it('updateAgentCapabilities validates reason field', () => {
    const tools = ROLE_TOOLS['agent-management'] as Record<string, any>;
    const tool = tools.updateAgentCapabilitiesTool;
    const schema = tool.inputSchema;

    const valid = schema.safeParse({
      agentId: 'agent_123',
      reason: 'Granting code-execution for testing',
      assignedToolsets: ['comments', 'code-execution'],
    });
    assert.ok(valid.success, 'valid input with reason passes');
  });
});

describe('getAgentTool', () => {
  it('is defined in roster toolset', () => {
    const rosterTools = ROLE_TOOLS['roster'] as Record<string, any>;
    assert.ok('getAgentTool' in rosterTools, 'getAgentTool is in roster toolset');
    const tool = rosterTools.getAgentTool;
    assert.equal(tool.id, 'getAgent', 'tool id is getAgent');
  });

  it('validates exactly one of agentId or urlKey', () => {
    const rosterTools = ROLE_TOOLS['roster'] as Record<string, any>;
    const tool = rosterTools.getAgentTool;
    const schema = tool.inputSchema;

    const withAgentId = schema.safeParse({ agentId: 'agent_123' });
    assert.ok(withAgentId.success, 'agentId alone is valid');

    const withUrlKey = schema.safeParse({ urlKey: 'ceo' });
    assert.ok(withUrlKey.success, 'urlKey alone is valid');

    const withBoth = schema.safeParse({ agentId: 'agent_123', urlKey: 'ceo' });
    assert.ok(!withBoth.success, 'both agentId and urlKey fails');

    const withNeither = schema.safeParse({});
    assert.ok(!withNeither.success, 'neither agentId nor urlKey fails');
  });
});

describe('listAgentsTool', () => {
  it('supports includeArchived parameter', () => {
    const rosterTools = ROLE_TOOLS['roster'] as Record<string, any>;
    const tool = rosterTools.listAgentsTool;
    const schema = tool.inputSchema;

    const withInclude = schema.safeParse({ includeArchived: true });
    assert.ok(withInclude.success, 'includeArchived parameter is valid');

    const withoutInclude = schema.safeParse({});
    assert.ok(withoutInclude.success, 'omitting includeArchived is valid');
  });
});
