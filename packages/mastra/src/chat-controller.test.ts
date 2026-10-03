import { describe, it, expect, beforeEach } from 'vitest';
import { createChatAgentWithSkills } from './chat-controller';
import { createAgentWithSkills, assembleAgentTools } from './agent-factory';
import { db, agents, companies, llmProviders } from '@tourbillon/db';
import { createId } from '@tourbillon/shared';
import type { Agent as AgentRecord } from '@tourbillon/db';

describe('Chat ↔ Heartbeat Tool Parity', () => {
  let testCompanyId: string;
  let testProviderId: string;

  beforeEach(async () => {
    // Create a test company
    testCompanyId = createId();
    await db.insert(companies).values({
      id: testCompanyId,
      name: 'Test Company',
      slug: 'test-company-parity',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Create a test LLM provider
    testProviderId = createId();
    await db.insert(llmProviders).values({
      id: testProviderId,
      name: 'Test Provider',
      type: 'openai',
      baseUrl: 'http://localhost:1234/v1',
      apiKey: 'test-key',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  describe('Tool Assignment Parity', () => {
    it('should include web-search tools in both chat and heartbeat', async () => {
      const testAgentId = createId();
      const agentRecord: AgentRecord = await db
        .insert(agents)
        .values({
          id: testAgentId,
          companyId: testCompanyId,
          name: 'Test Agent with Web Search',
          urlKey: 'test-agent-websearch',
          role: 'ceo',
          assignedSkills: ['control-plane'],
          assignedToolsets: ['web-search'],
          runtimeConfig: {
            searxng: {
              url: 'http://localhost:8080',
            },
          },
          adapterType: 'lmstudio',
          modelId: 'test-model',
          providerId: testProviderId,
          active: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning()
        .then((rows) => rows[0]!);

      const companySettings = {
        searxng: {
          url: 'http://localhost:8080',
        },
      };

      const chatAgent = await createChatAgentWithSkills(agentRecord, { companySettings });
      const heartbeatTools = await assembleAgentTools(agentRecord, { companySettings });

      const chatToolIds = Object.keys(chatAgent.tools || {});
      const heartbeatToolIds = Object.keys(heartbeatTools);

      // Both should have web-search tools
      expect(chatToolIds).toContain('searxngSearchTool');
      expect(heartbeatToolIds).toContain('searxngSearchTool');
    });

    it('should include comments tools in both chat and heartbeat', async () => {
      const testAgentId = createId();
      const agentRecord: AgentRecord = await db
        .insert(agents)
        .values({
          id: testAgentId,
          companyId: testCompanyId,
          name: 'Test Agent with Comments',
          urlKey: 'test-agent-comments',
          role: 'engineer',
          assignedSkills: ['control-plane'],
          assignedToolsets: ['comments'],
          runtimeConfig: {},
          adapterType: 'lmstudio',
          modelId: 'test-model',
          providerId: testProviderId,
          active: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning()
        .then((rows) => rows[0]!);

      const chatAgent = await createChatAgentWithSkills(agentRecord);
      const heartbeatTools = await assembleAgentTools(agentRecord);

      const chatToolIds = Object.keys(chatAgent.tools || {});
      const heartbeatToolIds = Object.keys(heartbeatTools);

      expect(chatToolIds).toContain('addCommentTool');
      expect(heartbeatToolIds).toContain('addCommentTool');
    });

    it('should NOT include web-search when toolset is not assigned', async () => {
      const testAgentId = createId();
      const agentRecord: AgentRecord = await db
        .insert(agents)
        .values({
          id: testAgentId,
          companyId: testCompanyId,
          name: 'Test Agent without Web Search',
          urlKey: 'test-agent-no-websearch',
          role: 'engineer',
          assignedSkills: ['control-plane'],
          assignedToolsets: [],
          runtimeConfig: {},
          adapterType: 'lmstudio',
          modelId: 'test-model',
          providerId: testProviderId,
          active: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning()
        .then((rows) => rows[0]!);

      const chatAgent = await createChatAgentWithSkills(agentRecord);
      const heartbeatTools = await assembleAgentTools(agentRecord);

      const chatToolIds = Object.keys(chatAgent.tools || {});
      const heartbeatToolIds = Object.keys(heartbeatTools);

      expect(chatToolIds).not.toContain('searxngSearchTool');
      expect(heartbeatToolIds).not.toContain('searxngSearchTool');
    });

    it('should include approvals tools in both chat and heartbeat', async () => {
      const testAgentId = createId();
      const agentRecord: AgentRecord = await db
        .insert(agents)
        .values({
          id: testAgentId,
          companyId: testCompanyId,
          name: 'Test Agent with Approvals',
          urlKey: 'test-agent-approvals',
          role: 'ceo',
          assignedSkills: ['control-plane'],
          assignedToolsets: ['approvals'],
          runtimeConfig: {},
          adapterType: 'lmstudio',
          modelId: 'test-model',
          providerId: testProviderId,
          active: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning()
        .then((rows) => rows[0]!);

      const chatAgent = await createChatAgentWithSkills(agentRecord);
      const heartbeatTools = await assembleAgentTools(agentRecord);

      const chatToolIds = Object.keys(chatAgent.tools || {});
      const heartbeatToolIds = Object.keys(heartbeatTools);

      expect(chatToolIds).toContain('createApprovalTool');
      expect(heartbeatToolIds).toContain('createApprovalTool');
    });

    it('should have equal tool sets for same agent config', async () => {
      const testAgentId = createId();
      const agentRecord: AgentRecord = await db
        .insert(agents)
        .values({
          id: testAgentId,
          companyId: testCompanyId,
          name: 'Test Agent Full Config',
          urlKey: 'test-agent-full',
          role: 'ceo',
          assignedSkills: ['control-plane'],
          assignedToolsets: ['web-search', 'comments', 'approvals', 'roster'],
          runtimeConfig: {
            searxng: {
              url: 'http://localhost:8080',
            },
          },
          adapterType: 'lmstudio',
          modelId: 'test-model',
          providerId: testProviderId,
          active: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning()
        .then((rows) => rows[0]!);

      const companySettings = {
        searxng: {
          url: 'http://localhost:8080',
        },
      };

      const chatAgent = await createChatAgentWithSkills(agentRecord, { companySettings });
      const heartbeatTools = await assembleAgentTools(agentRecord, { companySettings });

      const chatToolIds = new Set(Object.keys(chatAgent.tools || {}));
      const heartbeatToolIds = new Set(Object.keys(heartbeatTools));

      // Tool sets should be equal (same size and contents)
      expect(chatToolIds.size).toBe(heartbeatToolIds.size);

      // All heartbeat tools should be in chat
      for (const toolId of heartbeatToolIds) {
        expect(chatToolIds.has(toolId)).toBe(true);
      }
    });
  });

  describe('Meta-tools Always Available', () => {
    it('should include listTools and getToolDetails in both modes', async () => {
      const testAgentId = createId();
      const agentRecord: AgentRecord = await db
        .insert(agents)
        .values({
          id: testAgentId,
          companyId: testCompanyId,
          name: 'Test Agent Minimal',
          urlKey: 'test-agent-minimal',
          role: 'engineer',
          assignedSkills: ['control-plane'],
          assignedToolsets: [],
          runtimeConfig: {},
          adapterType: 'lmstudio',
          modelId: 'test-model',
          providerId: testProviderId,
          active: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning()
        .then((rows) => rows[0]!);

      const chatAgent = await createChatAgentWithSkills(agentRecord);
      const heartbeatTools = await assembleAgentTools(agentRecord);

      const chatToolIds = Object.keys(chatAgent.tools || {});
      const heartbeatToolIds = Object.keys(heartbeatTools);

      expect(chatToolIds).toContain('listToolsTool');
      expect(chatToolIds).toContain('getToolDetailsTool');
      expect(heartbeatToolIds).toContain('listToolsTool');
      expect(heartbeatToolIds).toContain('getToolDetailsTool');
    });
  });
});
