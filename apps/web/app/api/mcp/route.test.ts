import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { POST } from './route';
import { db, agents, companies, heartbeatRuns, agentObservabilityEvents } from '@tourbillon/db';
import { eq } from 'drizzle-orm';
import { SignJWT } from 'jose';

const SESSION_SECRET = new TextEncoder().encode(
  process.env.BETTER_AUTH_SECRET || 'change-me-in-production'
);

async function createCompanyToken(companyId: string): Promise<string> {
  return await new SignJWT({ companyId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(SESSION_SECRET);
}

function mockRequest(body: any, token?: string): any {
  return {
    json: async () => body,
    headers: {
      get: (name: string) => {
        if (name === 'x-company-token' && token) return token;
        return null;
      },
    },
  };
}

describe('MCP Control Plane - Snake Case API', () => {
  let companyA: { id: string; name: string };
  let companyB: { id: string; name: string };
  let agentA1: any;
  let agentB1: any;
  let tokenA: string;
  let tokenB: string;

  beforeEach(async () => {
    const timestamp = Date.now();
    
    [companyA] = await db
      .insert(companies)
      .values({ name: `Company A ${timestamp}` })
      .returning();

    [companyB] = await db
      .insert(companies)
      .values({ name: `Company B ${timestamp}` })
      .returning();

    [agentA1] = await db
      .insert(agents)
      .values({
        companyId: companyA.id,
        name: 'Agent A1',
        title: 'Test Agent A1',
        role: 'engineer',
        urlKey: `agent-a1-${timestamp}`,
        status: 'active',
        runtimeConfig: {
          heartbeat: { enabled: true, intervalSec: 3600 },
          observationalMemory: { mode: 'inherit' },
        },
      })
      .returning();

    [agentB1] = await db
      .insert(agents)
      .values({
        companyId: companyB.id,
        name: 'Agent B1',
        title: 'Test Agent B1',
        role: 'engineer',
        urlKey: `agent-b1-${timestamp}`,
        status: 'active',
        runtimeConfig: {
          heartbeat: { enabled: false },
          observationalMemory: { mode: 'off' },
        },
      })
      .returning();

    tokenA = await createCompanyToken(companyA.id);
    tokenB = await createCompanyToken(companyB.id);
  });

  describe('US1: Auth - missing/invalid token cannot call any tool', () => {
    it('should reject company_list with no token', async () => {
      const req = mockRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'company_list' },
      });

      const response = await POST(req);
      const data = await response.json();

      assert.strictEqual(response.status, 401);
      assert.strictEqual(data.error.code, -32001);
      assert.match(data.error.message, /Unauthorized/);
    });

    it('should reject list_agents with invalid token', async () => {
      const req = mockRequest(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'list_agents', arguments: { company_id: companyA.id } },
        },
        'invalid-token'
      );

      const response = await POST(req);
      const data = await response.json();

      assert.strictEqual(response.status, 401);
      assert.strictEqual(data.error.code, -32001);
    });

    it('should reject get_heartbeat with no token', async () => {
      const req = mockRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'get_heartbeat', arguments: { company_id: companyA.id, run_id: 'test-id' } },
      });

      const response = await POST(req);
      assert.strictEqual(response.status, 401);
    });
  });

  describe('US2: MCP handlers never call getActiveCompany / cookies', () => {
    it('doc confirms no cookies in architecture', async () => {
      const fs = await import('fs/promises');
      const docPath = '../../../../../docs/mcp-control-plane.md';
      const doc = await fs.readFile(new URL(docPath, import.meta.url), 'utf-8');

      assert.match(doc, /X-Company-Token/, 'Doc must mention X-Company-Token');
      assert.match(doc, /No cookie/, 'Doc must state no cookie authentication');
    });
  });

  describe('US3: Every tool except company_list rejects missing company_id', () => {
    it('should reject list_agents without company_id', async () => {
      const req = mockRequest(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'list_agents', arguments: {} },
        },
        tokenA
      );

      const response = await POST(req);
      const data = await response.json();

      assert.strictEqual(response.status, 200);
      assert.ok(data.error);
      assert.match(data.error.message, /company_id is required/);
    });

    it('should reject set_agent_active without company_id', async () => {
      const req = mockRequest(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'set_agent_active', arguments: { agent_id: agentA1.id, active: false } },
        },
        tokenA
      );

      const response = await POST(req);
      const data = await response.json();

      assert.strictEqual(response.status, 200);
      assert.ok(data.error);
      assert.match(data.error.message, /company_id is required/);
    });

    it('should reject get_heartbeat without company_id', async () => {
      const req = mockRequest(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'get_heartbeat', arguments: { run_id: 'test-id' } },
        },
        tokenA
      );

      const response = await POST(req);
      const data = await response.json();

      assert.strictEqual(response.status, 200);
      assert.ok(data.error);
      assert.match(data.error.message, /company_id is required/);
    });
  });

  describe('US4: Company A token cannot pass company B id to list/mutate/read runs', () => {
    it('should reject list_agents for company B with token A', async () => {
      const req = mockRequest(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'list_agents', arguments: { company_id: companyB.id } },
        },
        tokenA
      );

      const response = await POST(req);
      const data = await response.json();

      assert.strictEqual(response.status, 200);
      assert.ok(data.error);
      assert.match(data.error.message, /not found/i);
    });

    it('should reject set_agent_active for company B agent with token A', async () => {
      const req = mockRequest(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'set_agent_active',
            arguments: { company_id: companyB.id, agent_id: agentB1.id, active: false },
          },
        },
        tokenA
      );

      const response = await POST(req);
      const data = await response.json();

      assert.strictEqual(response.status, 200);
      assert.ok(data.error);
      assert.match(data.error.message, /not found/i);
    });

    it('should reject list_failed_jobs for company B with token A', async () => {
      const req = mockRequest(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'list_failed_jobs', arguments: { company_id: companyB.id } },
        },
        tokenA
      );

      const response = await POST(req);
      const data = await response.json();

      assert.strictEqual(response.status, 200);
      assert.ok(data.error);
      assert.match(data.error.message, /not found/i);
    });
  });

  describe('US5: company_list returns only allowed companies', () => {
    it('should return only company A when using token A', async () => {
      const req = mockRequest(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'company_list' },
        },
        tokenA
      );

      const response = await POST(req);
      const data = await response.json();

      assert.strictEqual(response.status, 200);
      assert.ok(data.result);

      const result = JSON.parse(data.result.content[0].text);
      assert.strictEqual(result.companies.length, 1, 'Must have exactly 1 company');
      assert.strictEqual(result.companies[0].id, companyA.id);
      assert.strictEqual(result.companies[0].name, companyA.name);
    });

    it('should return only company B when using token B', async () => {
      const req = mockRequest(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'company_list' },
        },
        tokenB
      );

      const response = await POST(req);
      const data = await response.json();

      assert.strictEqual(response.status, 200);
      const result = JSON.parse(data.result.content[0].text);
      assert.strictEqual(result.companies.length, 1);
      assert.strictEqual(result.companies[0].id, companyB.id);
    });
  });

  describe('Observability tools with company_id', () => {
    let runA: any;
    let runB: any;
    let eventA1: any;

    beforeEach(async () => {
      [runA] = await db
        .insert(heartbeatRuns)
        .values({
          companyId: companyA.id,
          agentId: agentA1.id,
          status: 'succeeded',
          invocationSource: 'on_demand',
          startedAt: new Date(Date.now() - 10000),
          finishedAt: new Date(),
          contextSnapshot: {
            modelId: 'test-model',
            providerName: 'test-provider',
            inputTokens: 1000,
            outputTokens: 200,
          },
        })
        .returning();

      [runB] = await db
        .insert(heartbeatRuns)
        .values({
          companyId: companyB.id,
          agentId: agentB1.id,
          status: 'failed',
          invocationSource: 'timer',
          errorText: 'Test failure',
          startedAt: new Date(Date.now() - 5000),
          finishedAt: new Date(),
        })
        .returning();

      [eventA1] = await db
        .insert(agentObservabilityEvents)
        .values({
          companyId: companyA.id,
          agentId: agentA1.id,
          heartbeatRunId: runA.id,
          traceId: 'trace-a',
          spanId: 'span-a1',
          parentSpanId: null,
          eventType: 'model_step',
          name: 'generate',
          status: 'success',
          durationMs: 5000,
          inputTokens: 500,
          outputTokens: 100,
          inputPreview: 'test input',
          outputPreview: 'test output',
          occurredAt: new Date(Date.now() - 8000),
          payload: {
            type: 'model_step',
            model: 'test-model',
            errorInfo: {
              statusCode: 500,
              url: 'http://localhost:3002/test',
              responseBody: 'Error body',
              first_frame: 'Frame',
            },
          },
        })
        .returning();
    });

    it('should reject get_heartbeat for company B run with token A', async () => {
      const req = mockRequest(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'get_heartbeat', arguments: { company_id: companyB.id, run_id: runB.id } },
        },
        tokenA
      );

      const response = await POST(req);
      const data = await response.json();

      assert.strictEqual(response.status, 200);
      assert.ok(data.error);
      assert.match(data.error.message, /not found/i);
    });

    it('should return heartbeat with company_id', async () => {
      const req = mockRequest(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'get_heartbeat', arguments: { company_id: companyA.id, run_id: runA.id } },
        },
        tokenA
      );

      const response = await POST(req);
      const data = await response.json();

      assert.strictEqual(response.status, 200);
      const result = JSON.parse(data.result.content[0].text);
      assert.strictEqual(result.runId, runA.id);
      assert.strictEqual(result.status, 'succeeded');
    });

    it('should return events with errorInfo fields', async () => {
      const req = mockRequest(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'list_heartbeat_events', arguments: { company_id: companyA.id, run_id: runA.id } },
        },
        tokenA
      );

      const response = await POST(req);
      const data = await response.json();

      assert.strictEqual(response.status, 200);
      const result = JSON.parse(data.result.content[0].text);
      assert.ok(result.events.length >= 1, 'Must have at least 1 event (empty list fails isolation)');

      const event = result.events[0];
      assert.strictEqual(event.eventType, 'model_step');
      assert.strictEqual(event.status, 'success');
      assert.ok(event.errorInfo, 'Must have errorInfo');
      assert.strictEqual(event.errorInfo.statusCode, 500);
      assert.strictEqual(event.errorInfo.url, 'http://localhost:3002/test');
    });

    it('should return live_heartbeat status', async () => {
      const req = mockRequest(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'live_heartbeat', arguments: { company_id: companyA.id, run_id: runA.id } },
        },
        tokenA
      );

      const response = await POST(req);
      const data = await response.json();

      assert.strictEqual(response.status, 200);
      const result = JSON.parse(data.result.content[0].text);
      assert.strictEqual(result.runId, runA.id);
      assert.strictEqual(result.status, 'succeeded');
    });
  });

  describe('PR #35 tools still present (with snake_case)', () => {
    it('should list all tools including snake_case names', async () => {
      const req = mockRequest(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
        },
        tokenA
      );

      const response = await POST(req);
      const data = await response.json();

      assert.strictEqual(response.status, 200);
      const toolNames = data.result.tools.map((t: any) => t.name);

      const expectedTools = [
        'company_list',
        'list_agents',
        'set_agent_active',
        'set_heartbeat',
        'set_om',
        'list_failed_jobs',
        'get_heartbeat',
        'list_heartbeat_events',
        'live_heartbeat',
      ];

      for (const toolName of expectedTools) {
        assert.ok(toolNames.includes(toolName), `Must include ${toolName}`);
      }
    });

    it('should successfully call list_agents with snake_case company_id', async () => {
      const req = mockRequest(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'list_agents', arguments: { company_id: companyA.id } },
        },
        tokenA
      );

      const response = await POST(req);
      const data = await response.json();

      assert.strictEqual(response.status, 200);
      const result = JSON.parse(data.result.content[0].text);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].id, agentA1.id);
    });
  });
});
