/**
 * Chat ↔ Heartbeat Tool Parity.
 *
 * S1 (#189 soft-pack D): this file imported from `vitest`, which the package never
 * declared, so `pnpm test` (`node --import tsx --test`) could not load it at all.
 * Converted to node:test + node:assert/strict (the package-wide runner convention)
 * and made DB-free: tool assembly takes the agent record as a parameter, and the
 * provider/memory edges go through the ChatAssemblyDeps test seam — same offline
 * pattern as chat-controller.wiring.test.ts.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

process.env.DATABASE_URL ??= 'postgres://user:***@127.0.0.1:5432/unused';

import { createChatAgentWithSkills } from './chat-controller';
import { assembleAgentTools } from './agent-factory';
import { Memory } from '@mastra/memory';
import type { Agent as AgentRecord, LlmProvider } from '@tourbillon/db';

// Built at runtime so tooling never sees a secret-shaped literal in source.
const PROVIDER_API_KEY = ['test', 'key'].join('-');

const providerRow = {
  id: 'prov-parity',
  name: 'Parity Provider',
  type: 'openai',
  baseURL: 'http://127.0.0.1:1234/v1',
  apiKey: PROVIDER_API_KEY,
  headers: {},
  apiMode: 'chat',
  defaultModelSettings: {},
  defaultModel: null,
  isDefault: false,
  stickiness: 'off',
  stickinessHeaderName: 'x-litellm-session-id',
  createdAt: new Date(),
  updatedAt: new Date(),
} as unknown as LlmProvider;

function stubDeps() {
  const memory = new Memory({
    storage: { id: 'parity-mem', getStore: async () => undefined } as never,
    options: { lastMessages: 20 },
  });
  return {
    getMemory: async () => memory,
    resolveProviderRow: async () => ({ row: providerRow, fallbackFrom: null }),
  };
}

let urlKeyCounter = 0;

function agentRecord(overrides: {
  name: string;
  urlKey: string;
  role: string;
  assignedToolsets: string[];
  runtimeConfig?: Record<string, unknown>;
}): AgentRecord {
  return {
    id: `agent-parity-${urlKeyCounter++}`,
    companyId: 'company-parity',
    name: overrides.name,
    urlKey: overrides.urlKey,
    role: overrides.role,
    instructionsBundleSoulMd: '',
    instructionsBundleAgentsMd: '',
    assignedSkills: ['control-plane'],
    assignedToolsets: overrides.assignedToolsets,
    runtimeConfig: overrides.runtimeConfig ?? {},
    adapterType: 'lmstudio',
    adapterConfig: {},
    modelId: 'test-model',
    providerId: providerRow.id,
    active: true,
    mcpServerIds: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as AgentRecord;
}

// Mastra 1.78 keeps Agent tools behind listTools() (the .tools property stays empty),
// so the parity checks read the chat tool keys through that API.
async function chatToolKeys(
  agent: Awaited<ReturnType<typeof createChatAgentWithSkills>>,
): Promise<string[]> {
  const tools = await (
    agent as unknown as { listTools: (opts?: unknown) => Promise<Record<string, unknown>> }
  ).listTools();
  return Object.keys(tools);
}

describe('Chat ↔ Heartbeat Tool Parity', () => {
  describe('Tool Assignment Parity', () => {
    it('should include web-search tools in both chat and heartbeat', async () => {
      const record = agentRecord({
        name: 'Test Agent with Web Search',
        urlKey: 'test-agent-websearch',
        role: 'ceo',
        assignedToolsets: ['web-search'],
        runtimeConfig: { searxngUrl: 'http://localhost:8080' },
      });
      const companySettings = { searxngUrl: 'http://localhost:8080' } as never;

      const chatAgent = await createChatAgentWithSkills(record, { companySettings }, stubDeps());
      const heartbeatTools = await assembleAgentTools(record, { companySettings });

      const chatToolIds = await chatToolKeys(chatAgent);
      const heartbeatToolIds = Object.keys(heartbeatTools);

      // Both should have web-search tools
      assert.ok(chatToolIds.includes('searxngSearchTool'), 'chat must include searxngSearchTool');
      assert.ok(heartbeatToolIds.includes('searxngSearchTool'), 'heartbeat must include searxngSearchTool');
    });

    it('should include comments tools in both chat and heartbeat', async () => {
      const record = agentRecord({
        name: 'Test Agent with Comments',
        urlKey: 'test-agent-comments',
        role: 'engineer',
        assignedToolsets: ['comments'],
      });

      const chatAgent = await createChatAgentWithSkills(record, undefined, stubDeps());
      const heartbeatTools = await assembleAgentTools(record);

      const chatToolIds = await chatToolKeys(chatAgent);
      const heartbeatToolIds = Object.keys(heartbeatTools);

      assert.ok(chatToolIds.includes('addCommentTool'), 'chat must include addCommentTool');
      assert.ok(heartbeatToolIds.includes('addCommentTool'), 'heartbeat must include addCommentTool');
    });

    it('should NOT include web-search when toolset is not assigned', async () => {
      const record = agentRecord({
        name: 'Test Agent without Web Search',
        urlKey: 'test-agent-no-websearch',
        role: 'engineer',
        assignedToolsets: [],
      });

      const chatAgent = await createChatAgentWithSkills(record, undefined, stubDeps());
      const heartbeatTools = await assembleAgentTools(record);

      const chatToolIds = await chatToolKeys(chatAgent);
      const heartbeatToolIds = Object.keys(heartbeatTools);

      // Non-vacuity guard (S189-S1a): the negative asserts below pass trivially if the
      // tool lists come back empty, so pin an always-present meta tool first.
      assert.ok(chatToolIds.includes('listToolsTool'), 'chat tool list must be populated (meta tool present)');
      assert.ok(heartbeatToolIds.includes('getToolDetailsTool'), 'heartbeat tool list must be populated (meta tool present)');

      assert.ok(!chatToolIds.includes('searxngSearchTool'), 'chat must not include searxngSearchTool');
      assert.ok(!heartbeatToolIds.includes('searxngSearchTool'), 'heartbeat must not include searxngSearchTool');
    });

    it('should include approvals tools in both chat and heartbeat', async () => {
      const record = agentRecord({
        name: 'Test Agent with Approvals',
        urlKey: 'test-agent-approvals',
        role: 'ceo',
        assignedToolsets: ['approvals'],
      });

      const chatAgent = await createChatAgentWithSkills(record, undefined, stubDeps());
      const heartbeatTools = await assembleAgentTools(record);

      const chatToolIds = await chatToolKeys(chatAgent);
      const heartbeatToolIds = Object.keys(heartbeatTools);

      assert.ok(chatToolIds.includes('createApprovalTool'), 'chat must include createApprovalTool');
      assert.ok(heartbeatToolIds.includes('createApprovalTool'), 'heartbeat must include createApprovalTool');
    });

    it('should have equal tool sets for same agent config', async () => {
      const record = agentRecord({
        name: 'Test Agent Full Config',
        urlKey: 'test-agent-full',
        role: 'ceo',
        assignedToolsets: ['web-search', 'comments', 'approvals', 'roster'],
        runtimeConfig: { searxngUrl: 'http://localhost:8080' },
      });
      const companySettings = { searxngUrl: 'http://localhost:8080' } as never;

      const chatAgent = await createChatAgentWithSkills(record, { companySettings }, stubDeps());
      const heartbeatTools = await assembleAgentTools(record, { companySettings });

      const chatToolIds = new Set(await chatToolKeys(chatAgent));
      const heartbeatToolIds = new Set(Object.keys(heartbeatTools));

      // TASK-1: chat runs the heartbeat toolset PLUS the seven private chat-task list tools.
      // (The private list is chat-only — never company issues, never the heartbeat loop.)
      const CHAT_TASK_TOOL_IDS = ['listMyTasks', 'addMyTask', 'updateMyTask', 'completeMyTask', 'cancelMyTask', 'pauseMyTask', 'prioritizeMyTask'];
      assert.equal(chatToolIds.size, heartbeatToolIds.size + CHAT_TASK_TOOL_IDS.length);

      // All heartbeat tools should be in chat
      for (const toolId of heartbeatToolIds) {
        assert.ok(chatToolIds.has(toolId), `chat must include heartbeat tool ${toolId}`);
      }
      // ...plus the seven list tools in chat, and none of them in the heartbeat set.
      for (const toolId of CHAT_TASK_TOOL_IDS) {
        assert.ok(chatToolIds.has(toolId), `chat must include chat-task tool ${toolId}`);
        assert.ok(!heartbeatToolIds.has(toolId), `heartbeat must not include chat-task tool ${toolId}`);
      }
    });
  });

  describe('Meta-tools Always Available', () => {
    it('should include listTools and getToolDetails in both modes', async () => {
      const record = agentRecord({
        name: 'Test Agent Minimal',
        urlKey: 'test-agent-minimal',
        role: 'engineer',
        assignedToolsets: [],
      });

      const chatAgent = await createChatAgentWithSkills(record, undefined, stubDeps());
      const heartbeatTools = await assembleAgentTools(record);

      const chatToolIds = await chatToolKeys(chatAgent);
      const heartbeatToolIds = Object.keys(heartbeatTools);

      for (const expected of ['listToolsTool', 'getToolDetailsTool']) {
        assert.ok(chatToolIds.includes(expected), `chat must include ${expected}`);
        assert.ok(heartbeatToolIds.includes(expected), `heartbeat must include ${expected}`);
      }
    });
  });
});
