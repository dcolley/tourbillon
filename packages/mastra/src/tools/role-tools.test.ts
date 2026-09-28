import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { ROLE_TOOLS } from './role-tools';

describe('createAgentTool', () => {
  it('is defined and exported in rosterTools', () => {
    const rosterTools = ROLE_TOOLS['roster'];
    assert.ok(rosterTools, 'roster toolset exists');
    assert.ok('createAgentTool' in rosterTools, 'createAgentTool is in roster toolset');
    assert.ok('listAgentsTool' in rosterTools, 'listAgentsTool is in roster toolset');
  });

  it('is available via agent-management alias', () => {
    const agentManagementTools = ROLE_TOOLS['agent-management'];
    assert.ok(agentManagementTools, 'agent-management toolset exists');
    assert.ok('createAgentTool' in agentManagementTools, 'createAgentTool is in agent-management toolset');
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

  it('accepts optional instructionsBundleSoulMd field', () => {
    const rosterTools = ROLE_TOOLS['roster'] as Record<string, any>;
    const createAgentTool = rosterTools.createAgentTool;
    const schema = createAgentTool.inputSchema;

    const withSoulMd = schema.safeParse({
      name: 'Sarah Chen',
      title: 'CFO',
      role: 'custom',
      instructionsBundleSoulMd: '# Soul\n\nBe methodical and detail-oriented.',
    });
    assert.ok(withSoulMd.success, 'instructionsBundleSoulMd is accepted');
  });

  it('accepts optional instructionsBundleAgentsMd field', () => {
    const rosterTools = ROLE_TOOLS['roster'] as Record<string, any>;
    const createAgentTool = rosterTools.createAgentTool;
    const schema = createAgentTool.inputSchema;

    const withAgentsMd = schema.safeParse({
      name: 'Sarah Chen',
      title: 'CFO',
      role: 'custom',
      instructionsBundleAgentsMd: '# Team\n\nReports to CEO.',
    });
    assert.ok(withAgentsMd.success, 'instructionsBundleAgentsMd is accepted');
  });

  it('accepts optional codeExecutionEnabled field', () => {
    const rosterTools = ROLE_TOOLS['roster'] as Record<string, any>;
    const createAgentTool = rosterTools.createAgentTool;
    const schema = createAgentTool.inputSchema;

    const withCodeExecutionTrue = schema.safeParse({
      name: 'Sarah Chen',
      title: 'CFO',
      role: 'custom',
      codeExecutionEnabled: true,
    });
    assert.ok(withCodeExecutionTrue.success, 'codeExecutionEnabled true is accepted');

    const withCodeExecutionFalse = schema.safeParse({
      name: 'Sarah Chen',
      title: 'CFO',
      role: 'custom',
      codeExecutionEnabled: false,
    });
    assert.ok(withCodeExecutionFalse.success, 'codeExecutionEnabled false is accepted');
  });

  it('accepts all new optional fields together', () => {
    const rosterTools = ROLE_TOOLS['roster'] as Record<string, any>;
    const createAgentTool = rosterTools.createAgentTool;
    const schema = createAgentTool.inputSchema;

    const withAllNewFields = schema.safeParse({
      name: 'Sarah Chen',
      title: 'Chief Financial Officer',
      role: 'custom',
      instructionsBundleSoulMd: '# Soul\n\nBe methodical.',
      instructionsBundleAgentsMd: '# Team\n\nReports to CEO.',
      codeExecutionEnabled: false,
    });
    assert.ok(withAllNewFields.success, 'all new optional fields are accepted together');
  });
});
