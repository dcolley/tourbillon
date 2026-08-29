import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { POST } from './route';
import { db, agents, companies, heartbeatRuns } from '@tourbillon/db';
import { eq, and } from 'drizzle-orm';
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

describe('MCP Control Plane', () => {
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
    it('should reject request with no token', async () => {
      const req = mockRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'list_agents' },
      });

      const response = await POST(req);
      const data = await response.json();

      assert.strictEqual(response.status, 401);
      assert.strictEqual(data.error.code, -32001);
      assert.match(data.error.message, /Unauthorized/);
    });

    it('should reject request with invalid token', async () => {
      const req = mockRequest(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'list_agents' },
        },
        'invalid-token'
      );

      const response = await POST(req);
      const data = await response.json();

      assert.strictEqual(response.status, 401);
      assert.strictEqual(data.error.code, -32001);
    });
  });

  describe('US2: Isolation - company A token cannot list or mutate company B', () => {
    it('should list only company A agents when using token A', async () => {
      const req = mockRequest(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'list_agents' },
        },
        tokenA
      );

      const response = await POST(req);
      const data = await response.json();

      assert.strictEqual(response.status, 200);
      assert.strictEqual(data.jsonrpc, '2.0');
      assert.ok(data.result);

      const agents = JSON.parse(data.result.content[0].text);
      assert.strictEqual(agents.length, 1, 'Must have exactly 1 agent (empty list fails isolation)');
      assert.strictEqual(agents[0].name, 'Agent A1');
      assert.ok(agents[0].urlKey.startsWith('agent-a1-'), `urlKey must start with agent-a1-, got ${agents[0].urlKey}`);
      assert.strictEqual(agents[0].id, agentA1.id);
    });

    it('should list only company B agents when using token B', async () => {
      const req = mockRequest(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'list_agents' },
        },
        tokenB
      );

      const response = await POST(req);
      const data = await response.json();

      assert.strictEqual(response.status, 200);
      const agents = JSON.parse(data.result.content[0].text);
      assert.strictEqual(agents.length, 1);
      assert.strictEqual(agents[0].name, 'Agent B1');
    });

    it('should reject mutation of company B agent with token A', async () => {
      const req = mockRequest(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'set_agent_active',
            arguments: { agentId: agentB1.id, active: false },
          },
        },
        tokenA
      );

      const response = await POST(req);
      const data = await response.json();

      assert.strictEqual(response.status, 200);
      assert.ok(data.error);
      assert.match(data.error.message, /does not belong to this company/);
    });
  });

  describe('US3: set-active persists', () => {
    it('should persist active=false (paused status)', async () => {
      const req = mockRequest(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'set_agent_active',
            arguments: { agentId: agentA1.id, active: false },
          },
        },
        tokenA
      );

      const response = await POST(req);
      const data = await response.json();

      assert.strictEqual(response.status, 200);
      assert.ok(data.result);

      const result = JSON.parse(data.result.content[0].text);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.status, 'paused');

      const stored = await db.query.agents.findFirst({
        where: eq(agents.id, agentA1.id),
      });
      assert.strictEqual(stored?.status, 'paused');
    });

    it('should persist active=true (active status)', async () => {
      await db.update(agents).set({ status: 'paused' }).where(eq(agents.id, agentA1.id));

      const req = mockRequest(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'set_agent_active',
            arguments: { agentId: agentA1.id, active: true },
          },
        },
        tokenA
      );

      const response = await POST(req);
      const data = await response.json();

      assert.strictEqual(response.status, 200);
      const result = JSON.parse(data.result.content[0].text);
      assert.strictEqual(result.status, 'active');

      const stored = await db.query.agents.findFirst({
        where: eq(agents.id, agentA1.id),
      });
      assert.strictEqual(stored?.status, 'active');
    });
  });

  describe('US4: set-heartbeat persists including timer off', () => {
    it('should persist heartbeat interval', async () => {
      const req = mockRequest(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'set_agent_heartbeat',
            arguments: {
              agentId: agentA1.id,
              enabled: true,
              intervalSec: 7200,
            },
          },
        },
        tokenA
      );

      const response = await POST(req);
      const data = await response.json();

      assert.strictEqual(response.status, 200);
      const result = JSON.parse(data.result.content[0].text);
      assert.strictEqual(result.heartbeatEnabled, true);
      assert.strictEqual(result.heartbeatIntervalSec, 7200);
      assert.strictEqual(result.heartbeatScheduleMode, 'interval');

      const stored = await db.query.agents.findFirst({
        where: eq(agents.id, agentA1.id),
      });
      const config = stored?.runtimeConfig as any;
      assert.strictEqual(config.heartbeat.enabled, true);
      assert.strictEqual(config.heartbeat.intervalSec, 7200);
      assert.strictEqual(config.heartbeat.scheduleMode, 'interval');
    });

    it('should persist timer off (enabled=false)', async () => {
      const req = mockRequest(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'set_agent_heartbeat',
            arguments: {
              agentId: agentA1.id,
              enabled: false,
            },
          },
        },
        tokenA
      );

      const response = await POST(req);
      const data = await response.json();

      assert.strictEqual(response.status, 200);
      const result = JSON.parse(data.result.content[0].text);
      assert.strictEqual(result.heartbeatEnabled, false);

      const stored = await db.query.agents.findFirst({
        where: eq(agents.id, agentA1.id),
      });
      const config = stored?.runtimeConfig as any;
      assert.strictEqual(config.heartbeat.enabled, false);
    });

    it('should persist cron schedule', async () => {
      const req = mockRequest(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'set_agent_heartbeat',
            arguments: {
              agentId: agentA1.id,
              enabled: true,
              cronExpression: '0 9 * * 1-5',
            },
          },
        },
        tokenA
      );

      const response = await POST(req);
      const data = await response.json();

      assert.strictEqual(response.status, 200);
      const result = JSON.parse(data.result.content[0].text);
      assert.strictEqual(result.heartbeatCronExpression, '0 9 * * 1-5');
      assert.strictEqual(result.heartbeatScheduleMode, 'cron');

      const stored = await db.query.agents.findFirst({
        where: eq(agents.id, agentA1.id),
      });
      const config = stored?.runtimeConfig as any;
      assert.strictEqual(config.heartbeat.cronExpression, '0 9 * * 1-5');
      assert.strictEqual(config.heartbeat.scheduleMode, 'cron');
    });
  });

  describe('US5: failed-jobs list excludes succeeded', () => {
    it('should return only failed runs, not succeeded ones', async () => {
      const [failedRun] = await db
        .insert(heartbeatRuns)
        .values({
          companyId: companyA.id,
          agentId: agentA1.id,
          status: 'failed',
          errorText: 'Test error',
          invocationSource: 'timer',
          startedAt: new Date(),
          finishedAt: new Date(),
        })
        .returning();

      const [succeededRun] = await db
        .insert(heartbeatRuns)
        .values({
          companyId: companyA.id,
          agentId: agentA1.id,
          status: 'succeeded',
          invocationSource: 'timer',
          startedAt: new Date(),
          finishedAt: new Date(),
        })
        .returning();

      const req = mockRequest(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'list_failed_heartbeats' },
        },
        tokenA
      );

      const response = await POST(req);
      const data = await response.json();

      assert.strictEqual(response.status, 200);
      const result = JSON.parse(data.result.content[0].text);

      assert.strictEqual(result.entries.length, 1);
      assert.strictEqual(result.entries[0].runId, failedRun.id);
      assert.strictEqual(result.entries[0].errorText, 'Test error');

      const succeededIds = result.entries.map((e: any) => e.runId);
      assert.ok(!succeededIds.includes(succeededRun.id), 'Succeeded run must not be in results');
    });
  });

  describe('US6: connector doc names URL + auth header', () => {
    it('should document MCP URL and X-Company-Token header', async () => {
      const fs = await import('fs/promises');
      const docPath = '../../../../../docs/mcp-control-plane.md';
      const doc = await fs.readFile(new URL(docPath, import.meta.url), 'utf-8');

      assert.match(doc, /\/api\/mcp/, 'Doc must contain MCP URL path');
      assert.match(doc, /X-Company-Token/, 'Doc must contain X-Company-Token header name');
    });
  });
});
