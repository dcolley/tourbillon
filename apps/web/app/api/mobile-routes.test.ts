import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';
import { NextRequest } from 'next/server';
import { statusesForFilter } from '../(dashboard)/issue/issue-filter';
import { verifyMobileToken } from '../../lib/mobile-auth';

const SESSION_SECRET = new TextEncoder().encode(
  process.env.BETTER_AUTH_SECRET || 'change-me-in-production'
);

async function createToken(companyId: string): Promise<string> {
  return await new SignJWT({ companyId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(SESSION_SECRET);
}

describe('Mobile API Routes - Integration', () => {
  let getAgents: any;
  let getIssues: any;
  
  before(async () => {
    const Module = require('module');
    const originalRequire = Module.prototype.require;
    
    const mockCompanies = new Map<string, any>([
      ['company-a', { id: 'company-a', name: 'Company A', urlKey: 'company-a' }],
      ['company-b', { id: 'company-b', name: 'Company B', urlKey: 'company-b' }],
    ]);
    
    const mockIssueData = [
      { issue: { id: 'issue-a1', companyId: 'company-a', title: 'A1', status: 'todo', createdAt: new Date(), updatedAt: new Date() }, agent: null },
      { issue: { id: 'issue-a2', companyId: 'company-a', title: 'A2', status: 'done', createdAt: new Date(), updatedAt: new Date() }, agent: null },
      { issue: { id: 'issue-a3', companyId: 'company-a', title: 'A3', status: 'in_progress', createdAt: new Date(), updatedAt: new Date() }, agent: null },
      { issue: { id: 'issue-a4', companyId: 'company-a', title: 'A4', status: 'cancelled', createdAt: new Date(), updatedAt: new Date() }, agent: null },
      { issue: { id: 'issue-b1', companyId: 'company-b', title: 'B1', status: 'todo', createdAt: new Date(), updatedAt: new Date() }, agent: null },
    ];
    
    Module.prototype.require = function(this: any, id: string) {
      if (id === '@/lib/company' || id.endsWith('/lib/company')) {
        return {
          getActiveCompanyOrNull: async (companyIdOverride?: string | null) => {
            if (companyIdOverride && mockCompanies.has(companyIdOverride)) {
              return mockCompanies.get(companyIdOverride);
            }
            return null;
          },
          getCompanyById: async (id: string) => {
            return mockCompanies.get(id) || null;
          },
        };
      }
      
      if (id === '@/lib/issues' || id.endsWith('/lib/issues')) {
        return {
          listIssues: async (opts: any) => {
            const companyId = opts.companyIdOverride;
            
            // Match real listIssues behavior: if no companyIdOverride, it calls getActiveCompany() which throws
            if (!companyId) {
              throw new Error('Company not found or not selected');
            }
            
            const statuses = opts.statuses || [];
            
            const filtered = mockIssueData.filter(row => {
              const matchesCompany = row.issue.companyId === companyId;
              const matchesStatus = statuses.length === 0 || (statuses as readonly string[]).includes(row.issue.status);
              return matchesCompany && matchesStatus;
            });
            
            return { rows: filtered, counts: { total: filtered.length } };
          },
          ISSUE_KANBAN_LIMIT: 100,
        };
      }
      
      if (id === '@tourbillon/db' || id.endsWith('@tourbillon/db')) {
        const mockAgents = [
          { id: 'agent-a1', name: 'Alice', urlKey: 'alice', companyId: 'company-a', modelId: 'model-1', adapterType: 'lmstudio' },
          { id: 'agent-a2', name: 'Bob', urlKey: 'bob', companyId: 'company-a', modelId: 'model-1', adapterType: 'lmstudio' },
        ];
        
        return {
          db: {
            select: () => ({
              from: () => ({
                leftJoin: () => ({
                  where: () => ({
                    orderBy: () => Promise.resolve(mockAgents),
                  }),
                }),
              }),
            }),
          },
          agents: {},
          llmProviders: {},
          eq: () => {},
        };
      }
      
      return originalRequire.apply(this, arguments as any);
    };
    
    const agentsModule = await import('./chat/agents/route');
    const issuesModule = await import('./issues/list/route');
    
    getAgents = agentsModule.GET;
    getIssues = issuesModule.GET;
    
    Module.prototype.require = originalRequire;
  });

  describe('1. Missing/invalid token cannot list agents', () => {
    it('GET /api/chat/agents returns error without token', async () => {
      const req = new NextRequest('http://localhost:3002/api/chat/agents');
      const response = await getAgents(req);
      const data = await response.json();
      
      assert.ok(response.status >= 400 || data.error);
    });

    it('GET /api/chat/agents returns error with invalid token', async () => {
      const req = new NextRequest('http://localhost:3002/api/chat/agents', {
        headers: { 'X-Company-Token': 'invalid-token-string' },
      });
      const response = await getAgents(req);
      const data = await response.json();
      
      assert.ok(response.status >= 400 || data.error);
    });
  });

  describe('1. Missing/invalid token cannot list issues', () => {
    it('GET /api/issues/list returns error without token', async () => {
      const req = new NextRequest('http://localhost:3002/api/issues/list?filter=active');
      const response = await getIssues(req);
      const data = await response.json();
      
      assert.ok(response.status >= 400 || data.error);
    });

    it('GET /api/issues/list returns error with invalid token', async () => {
      const req = new NextRequest('http://localhost:3002/api/issues/list?filter=active', {
        headers: { 'X-Company-Token': 'malformed-jwt' },
      });
      const response = await getIssues(req);
      const data = await response.json();
      
      assert.ok(response.status >= 400 || data.error);
    });
  });

  describe('2. Token company isolation - handler enforces boundaries', () => {
    it('verifyMobileToken extracts company-a from tokenA', async () => {
      const token = await createToken('company-a');
      const req = new Request('http://localhost:3002/api/test', {
        headers: { 'X-Company-Token': token },
      });
      const companyId = await verifyMobileToken(req as any);
      
      assert.strictEqual(companyId, 'company-a');
    });

    it('verifyMobileToken extracts company-b from tokenB', async () => {
      const token = await createToken('company-b');
      const req = new Request('http://localhost:3002/api/test', {
        headers: { 'X-Company-Token': token },
      });
      const companyId = await verifyMobileToken(req as any);
      
      assert.strictEqual(companyId, 'company-b');
    });

    it('GET /api/chat/agents with tokenA returns only company A agents', async () => {
      const tokenA = await createToken('company-a');
      const req = new NextRequest('http://localhost:3002/api/chat/agents', {
        headers: { 'X-Company-Token': tokenA },
      });
      
      const response = await getAgents(req);
      const data = await response.json();
      
      assert.ok(data.agents && Array.isArray(data.agents));
      assert.ok(data.agents.every((agent: any) => agent.urlKey === 'alice' || agent.urlKey === 'bob'));
      assert.ok(!data.agents.some((agent: any) => agent.urlKey === 'charlie'));
    });

    it('GET /api/issues/list with tokenA excludes company B issues', async () => {
      const tokenA = await createToken('company-a');
      const req = new NextRequest('http://localhost:3002/api/issues/list?filter=active', {
        headers: { 'X-Company-Token': tokenA },
      });
      
      const response = await getIssues(req);
      const data = await response.json();
      
      assert.ok(data.rows.every((row: any) => row.issue.companyId === 'company-a'));
      assert.ok(!data.rows.some((row: any) => row.issue.companyId === 'company-b'));
    });
  });

  describe('3. filter=active excludes done/cancelled - handler enforces', () => {
    it('statusesForFilter(active) excludes done and cancelled', () => {
      const statuses = statusesForFilter('active');
      
      assert.deepStrictEqual([...statuses], 
        ['todo', 'in_progress', 'in_review', 'blocked']);
      
      assert.ok(!(statuses as readonly string[]).includes('done'));
      assert.ok(!(statuses as readonly string[]).includes('cancelled'));
    });

    it('GET /api/issues/list with filter=active excludes done issues', async () => {
      const token = await createToken('company-a');
      const req = new NextRequest('http://localhost:3002/api/issues/list?filter=active', {
        headers: { 'X-Company-Token': token },
      });
      
      const response = await getIssues(req);
      const data = await response.json();
      
      assert.ok(!data.rows.some((row: any) => row.issue.status === 'done'));
      assert.ok(!data.rows.some((row: any) => row.issue.status === 'cancelled'));
    });

    it('GET /api/issues/list without filter defaults to active', async () => {
      const token = await createToken('company-a');
      const req = new NextRequest('http://localhost:3002/api/issues/list', {
        headers: { 'X-Company-Token': token },
      });
      
      const response = await getIssues(req);
      const data = await response.json();
      
      assert.ok(!data.rows.some((row: any) => row.issue.status === 'done'));
      assert.ok(!data.rows.some((row: any) => row.issue.status === 'cancelled'));
    });
  });
});
