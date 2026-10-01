import { describe, it, expect, beforeEach } from 'vitest';
import { listToolsTool, getToolDetailsTool } from './tool-discovery-tools';
import { db, agents, companies } from '@tourbillon/db';
import { createId } from '@tourbillon/shared';
import type { RequestContext } from '@mastra/core/tools';

describe('Tool Discovery Tools', () => {
  let testCompanyId: string;
  let testAgentId: string;
  let mockContext: RequestContext;

  beforeEach(async () => {
    // Create a test company
    testCompanyId = createId();
    await db.insert(companies).values({
      id: testCompanyId,
      name: 'Test Company',
      slug: 'test-company',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Create a test agent with web-search toolset
    testAgentId = createId();
    await db.insert(agents).values({
      id: testAgentId,
      companyId: testCompanyId,
      name: 'Test Agent',
      urlKey: 'test-agent',
      role: 'ceo',
      assignedSkills: ['control-plane'],
      assignedToolsets: ['web-search', 'comments'],
      runtimeConfig: {},
      adapterType: 'lmstudio',
      modelId: 'test-model',
      active: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    mockContext = {
      requestId: 'test-request',
      agentId: testAgentId,
      companyId: testCompanyId,
      runId: 'test-run',
    } as RequestContext;
  });

  describe('listTools', () => {
    it('should return a compact list of available tools', async () => {
      const result = await listToolsTool.execute({}, { requestContext: mockContext });

      expect(result).toHaveProperty('tools');
      expect(result).toHaveProperty('count');
      expect(Array.isArray(result.tools)).toBe(true);
      expect(result.count).toBeGreaterThan(0);

      // Check structure of first tool
      const firstTool = result.tools[0];
      expect(firstTool).toHaveProperty('id');
      expect(firstTool).toHaveProperty('description');
      expect(typeof firstTool.description).toBe('string');
      expect(firstTool.description.length).toBeLessThan(300);
    });

    it('should include control-plane tools', async () => {
      const result = await listToolsTool.execute({}, { requestContext: mockContext });

      const toolIds = result.tools.map((t: any) => t.id);
      expect(toolIds).toContain('getIdentity');
      expect(toolIds).toContain('getInbox');
      expect(toolIds).toContain('checkoutIssue');
      expect(toolIds).toContain('listSkills');
      expect(toolIds).toContain('getSkill');
      expect(toolIds).toContain('listTools');
      expect(toolIds).toContain('getToolDetails');
    });

    it('should include assigned toolset tools', async () => {
      const result = await listToolsTool.execute({}, { requestContext: mockContext });

      const toolIds = result.tools.map((t: any) => t.id);
      // web-search toolset
      expect(toolIds).toContain('searxngSearch');
      // comments toolset
      expect(toolIds).toContain('addComment');
    });

    it('should mark toolset tools with toolset property', async () => {
      const result = await listToolsTool.execute({}, { requestContext: mockContext });

      const commentTool = result.tools.find((t: any) => t.id === 'addComment');
      expect(commentTool).toHaveProperty('toolset', 'comments');
    });

    it('should return error when agent not found', async () => {
      const invalidContext = {
        ...mockContext,
        agentId: 'invalid-agent-id',
      };

      const result = await listToolsTool.execute({}, { requestContext: invalidContext });

      expect(result).toHaveProperty('error', 'agent_not_found');
    });
  });

  describe('getToolDetails', () => {
    it('should return full details for a valid tool', async () => {
      const result = await getToolDetailsTool.execute(
        { id: 'getIdentity' },
        { requestContext: mockContext },
      );

      expect(result).toHaveProperty('id', 'getIdentity');
      expect(result).toHaveProperty('description');
      expect(result).toHaveProperty('inputSchema');
      expect(typeof result.description).toBe('string');
    });

    it('should return error and available ids for unknown tool', async () => {
      const result = await getToolDetailsTool.execute(
        { id: 'nonexistentTool' },
        { requestContext: mockContext },
      );

      expect(result).toHaveProperty('error', 'tool_not_found');
      expect(result).toHaveProperty('availableIds');
      expect(Array.isArray(result.availableIds)).toBe(true);
      expect(result.availableIds.length).toBeGreaterThan(0);
    });

    it('should return schema for assigned toolset tools', async () => {
      const result = await getToolDetailsTool.execute(
        { id: 'searxngSearch' },
        { requestContext: mockContext },
      );

      expect(result).toHaveProperty('id', 'searxngSearch');
      expect(result).toHaveProperty('inputSchema');
      expect(result).toHaveProperty('toolset', 'web-search');
    });

    it('should return error when agent not found', async () => {
      const invalidContext = {
        ...mockContext,
        agentId: 'invalid-agent-id',
      };

      const result = await getToolDetailsTool.execute(
        { id: 'getIdentity' },
        { requestContext: invalidContext },
      );

      expect(result).toHaveProperty('error', 'agent_not_found');
    });
  });
});
