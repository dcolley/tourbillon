import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';
import { NextRequest } from 'next/server';

const SESSION_SECRET = new TextEncoder().encode(
  process.env.BETTER_AUTH_SECRET || 'change-me-in-production'
);

async function tokenFor(companyId: string): Promise<string> {
  return new SignJWT({ companyId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(SESSION_SECRET);
}

describe('Mobile API Routes - New JWT endpoints', () => {
  let getAgent: any;
  let patchAgent: any;
  let getApprovals: any;
  let getProjects: any;
  let getGoals: any;
  let getSettings: any;

  before(async () => {
    const Module = require('module');
    const originalRequire = Module.prototype.require;

    const mockCompanies = new Map<string, any>([
      [
        'company-a',
        {
          id: 'company-a',
          name: 'Company A',
          urlKey: 'company-a',
          slug: 'company-a',
          issuePrefix: 'A',
          requiresBoardApprovalForHires: false,
          budgetMonthlyTokens: 1000000,
          allowedMcpServerIds: [],
          settings: {},
        },
      ],
      [
        'company-b',
        {
          id: 'company-b',
          name: 'Company B',
          urlKey: 'company-b',
          slug: 'company-b',
          issuePrefix: 'B',
          requiresBoardApprovalForHires: true,
          budgetMonthlyTokens: 500000,
          allowedMcpServerIds: [],
          settings: {},
        },
      ],
    ]);

    const mockAgents = [
      {
        id: 'agent-a1',
        name: 'Alice',
        urlKey: 'alice',
        title: 'CEO',
        role: 'ceo',
        companyId: 'company-a',
        modelId: 'model-1',
        adapterType: 'lmstudio',
        providerId: null,
        status: 'active',
        assignedSkills: [],
        assignedToolsets: [],
        mcpServerIds: [],
        budgetMonthlyTokens: 100000,
        spentMonthlyTokens: 0,
        runtimeConfig: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 'agent-b1',
        name: 'Charlie',
        urlKey: 'charlie',
        title: 'CTO',
        role: 'cto',
        companyId: 'company-b',
        modelId: 'model-1',
        adapterType: 'lmstudio',
        providerId: null,
        status: 'active',
        assignedSkills: [],
        assignedToolsets: [],
        mcpServerIds: [],
        budgetMonthlyTokens: 50000,
        spentMonthlyTokens: 0,
        runtimeConfig: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    const mockApprovals = [
      {
        id: 'approval-a1',
        companyId: 'company-a',
        type: 'hire_agent',
        status: 'pending',
        requestedByAgentId: 'agent-a1',
        issueIds: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 'approval-b1',
        companyId: 'company-b',
        type: 'request_board_approval',
        status: 'pending',
        requestedByAgentId: 'agent-b1',
        issueIds: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    const mockProjects = [
      {
        id: 'project-a1',
        companyId: 'company-a',
        title: 'Project A1',
        status: 'active',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 'project-b1',
        companyId: 'company-b',
        title: 'Project B1',
        status: 'active',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    const mockGoals = [
      {
        id: 'goal-a1',
        companyId: 'company-a',
        title: 'Goal A1',
        status: 'active',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 'goal-b1',
        companyId: 'company-b',
        title: 'Goal B1',
        status: 'active',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    Module.prototype.require = function (this: any, id: string) {
      if (id === '@/lib/mobile-session' || id.endsWith('/lib/mobile-session')) {
        return {
          requireMobileCompany: async (req: any) => {
            const token = req.headers.get('x-company-token');
            if (!token || typeof token !== 'string') {
              return {
                error: new Response(JSON.stringify({ error: 'Unauthorized' }), {
                  status: 401,
                  headers: { 'content-type': 'application/json' },
                }),
              };
            }
            try {
              const jose = originalRequire.apply(this, ['jose']);
              const secret = new TextEncoder().encode(
                process.env.BETTER_AUTH_SECRET || 'change-me-in-production'
              );
              const { payload } = await jose.jwtVerify(token, secret);
              const companyId = payload.companyId as string;
              const company = mockCompanies.get(companyId);
              if (!company) {
                return {
                  error: new Response(JSON.stringify({ error: 'Unauthorized' }), {
                    status: 401,
                    headers: { 'content-type': 'application/json' },
                  }),
                };
              }
              return { company };
            } catch {
              return {
                error: new Response(JSON.stringify({ error: 'Unauthorized' }), {
                  status: 401,
                  headers: { 'content-type': 'application/json' },
                }),
              };
            }
          },
          toJson: (data: any) => JSON.parse(JSON.stringify(data)),
        };
      }

      if (id === '@/lib/agents' || id.endsWith('/lib/agents')) {
        return {
          getAgentByUrlKey: async (urlKey: string, companyId: string) => {
            return mockAgents.find((a) => a.urlKey === urlKey && a.companyId === companyId) || null;
          },
          updateAgentProfile: async (agentId: string, data: any) => {
            const agent = mockAgents.find((a) => a.id === agentId);
            if (!agent) throw new Error('Agent not found');
            return { ...agent, ...data };
          },
          AGENT_ROLE_OPTIONS: ['ceo', 'cto', 'engineer'],
        };
      }

      if (id === '@/lib/llm-providers' || id.endsWith('/lib/llm-providers')) {
        return {
          listLlmProvidersPublic: async () => [
            { id: 'provider-1', name: 'LM Studio', type: 'lmstudio', isDefault: true },
          ],
        };
      }

      if (id === '@/lib/goals' || id.endsWith('/lib/goals')) {
        return {
          listGoalsForCompany: async (companyId: string, status: string) => {
            return mockGoals.filter((g) => g.companyId === companyId);
          },
        };
      }

      if (id === '@/lib/projects' || id.endsWith('/lib/projects')) {
        return {
          listProjectsForAgent: async (companyId: string, opts: any) => {
            return mockProjects.filter((p) => p.companyId === companyId);
          },
        };
      }

      if (id === '@tourbillon/shared' || id.endsWith('@tourbillon/shared')) {
        return {
          GRANULAR_TOOL_GROUPS: [],
          SKILL_CATALOG: [],
          TOOLSET_CATALOG: [],
          isHitlyGateConfigured: () => false,
          isSearxngConfigured: () => false,
          isTavilyConfigured: () => false,
          parseCompanySettings: (settings: any) => settings || {},
        };
      }

      if (id === '@tourbillon/shared/mcp-registry' || id.endsWith('/mcp-registry')) {
        return {
          listToggleableMcpServerDefinitions: (allowedIds: string[]) => [],
        };
      }

      if (id === 'drizzle-orm' || id.endsWith('drizzle-orm')) {
        return {
          ...originalRequire.apply(this, arguments as any),
          desc: () => ({}),
          eq: (field: any, value: any) => {
            // Capture company ID for filtering
            if (typeof value === 'string' && (value.startsWith('company-') || value === 'company-a' || value === 'company-b')) {
              (global as any).__mockCompanyId = value;
            }
            return { _mock: 'eq', field, value };
          },
          inArray: () => ({}),
        };
      }

      if (id === '@tourbillon/db' || id.endsWith('@tourbillon/db')) {
        return {
          db: {
            select: (fields?: any) => ({
              from: (table: any) => {
                const tableStr = table?.toString?.() || '';
                
                return {
                  leftJoin: (joinTable: any, condition: any) => ({
                    where: (whereCondition: any) => {
                      // Extract company ID from where condition
                      const companyId = (global as any).__mockCompanyId;
                      
                      return {
                        orderBy: (orderFn: any) => ({
                          limit: (count: number) => {
                            // For approvals query
                            if (companyId) {
                              const filtered = mockApprovals.filter((a) => a.companyId === companyId);
                              const rows = filtered.map((approval) => ({
                                approval,
                                agent: mockAgents.find((a) => a.id === approval.requestedByAgentId) || null,
                              }));
                              return Promise.resolve(rows);
                            }
                            // Fallback: return all
                            const rows = mockApprovals.map((approval) => ({
                              approval,
                              agent: mockAgents.find((a) => a.id === approval.requestedByAgentId) || null,
                            }));
                            return Promise.resolve(rows);
                          },
                        }),
                      };
                    },
                  }),
                  where: (condition: any) => {
                    const companyId = (global as any).__mockCompanyId;
                    
                    return {
                      leftJoin: () => ({
                        orderBy: () => ({
                          limit: () => Promise.resolve([]),
                        }),
                      }),
                      orderBy: (orderFn: any) => {
                        // For agents query - filter by company
                        if (companyId) {
                          const filtered = mockAgents.filter((a) => a.companyId === companyId);
                          return Promise.resolve(filtered);
                        }
                        return Promise.resolve(mockAgents);
                      },
                    };
                  },
                };
              },
            }),
          },
          approvals: {},
          agents: {},
          issues: {},
        };
      }

      return originalRequire.apply(this, arguments as any);
    };

    const agentsModule = await import('./agents/[urlKey]/route');
    const approvalsModule = await import('./approvals/route');
    const projectsModule = await import('./projects/route');
    const goalsModule = await import('./goals/route');
    const settingsModule = await import('./settings/route');

    getAgent = agentsModule.GET;
    patchAgent = agentsModule.PATCH;
    getApprovals = approvalsModule.GET;
    getProjects = projectsModule.GET;
    getGoals = goalsModule.GET;
    getSettings = settingsModule.GET;

    Module.prototype.require = originalRequire;
  });

  describe('1. Missing/invalid token returns 401 with JSON body', () => {
    it('GET /api/mobile/agents/[urlKey] without token returns 401', async () => {
      const req = new NextRequest('http://localhost/api/mobile/agents/alice');
      const response = await getAgent(req, { params: Promise.resolve({ urlKey: 'alice' }) });
      const data = await response.json();

      assert.strictEqual(response.status, 401);
      assert.ok(data.error);
      assert.strictEqual(data.error, 'Unauthorized');
    });

    it('GET /api/mobile/agents/[urlKey] with invalid token returns 401', async () => {
      const req = new NextRequest('http://localhost/api/mobile/agents/alice', {
        headers: { 'x-company-token': 'invalid-jwt-token' },
      });
      const response = await getAgent(req, { params: Promise.resolve({ urlKey: 'alice' }) });
      const data = await response.json();

      assert.strictEqual(response.status, 401);
      assert.ok(data.error);
      assert.strictEqual(data.error, 'Unauthorized');
    });

    it('PATCH /api/mobile/agents/[urlKey] without token returns 401', async () => {
      const req = new NextRequest('http://localhost/api/mobile/agents/alice', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ section: 'profile', name: 'Updated' }),
      });
      const response = await patchAgent(req, { params: Promise.resolve({ urlKey: 'alice' }) });
      const data = await response.json();

      assert.strictEqual(response.status, 401);
      assert.ok(data.error);
      assert.strictEqual(data.error, 'Unauthorized');
    });

    it('PATCH /api/mobile/agents/[urlKey] with invalid token returns 401', async () => {
      const req = new NextRequest('http://localhost/api/mobile/agents/alice', {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          'x-company-token': 'malformed-token',
        },
        body: JSON.stringify({ section: 'profile', name: 'Updated' }),
      });
      const response = await patchAgent(req, { params: Promise.resolve({ urlKey: 'alice' }) });
      const data = await response.json();

      assert.strictEqual(response.status, 401);
      assert.ok(data.error);
      assert.strictEqual(data.error, 'Unauthorized');
    });

    it('GET /api/mobile/approvals without token returns 401', async () => {
      const req = new NextRequest('http://localhost/api/mobile/approvals');
      const response = await getApprovals(req);
      const data = await response.json();

      assert.strictEqual(response.status, 401);
      assert.ok(data.error);
    });

    it('GET /api/mobile/projects without token returns 401', async () => {
      const req = new NextRequest('http://localhost/api/mobile/projects');
      const response = await getProjects(req);
      const data = await response.json();

      assert.strictEqual(response.status, 401);
      assert.ok(data.error);
    });

    it('GET /api/mobile/goals without token returns 401', async () => {
      const req = new NextRequest('http://localhost/api/mobile/goals');
      const response = await getGoals(req);
      const data = await response.json();

      assert.strictEqual(response.status, 401);
      assert.ok(data.error);
    });

    it('GET /api/mobile/settings without token returns 401', async () => {
      const req = new NextRequest('http://localhost/api/mobile/settings');
      const response = await getSettings(req);
      const data = await response.json();

      assert.strictEqual(response.status, 401);
      assert.ok(data.error);
    });
  });

  describe('2. Company A token cannot access Company B data', () => {
    it('GET /api/mobile/agents/[urlKey] with tokenA cannot fetch charlie (company B)', async () => {
      const tokenA = await tokenFor('company-a');
      const req = new NextRequest('http://localhost/api/mobile/agents/charlie', {
        headers: { 'x-company-token': tokenA },
      });
      const response = await getAgent(req, { params: Promise.resolve({ urlKey: 'charlie' }) });
      const data = await response.json();

      assert.strictEqual(response.status, 404);
      assert.ok(data.error);
    });

    it('GET /api/mobile/agents/[urlKey] with tokenA can fetch alice (company A)', async () => {
      const tokenA = await tokenFor('company-a');
      const req = new NextRequest('http://localhost/api/mobile/agents/alice', {
        headers: { 'x-company-token': tokenA },
      });
      const response = await getAgent(req, { params: Promise.resolve({ urlKey: 'alice' }) });
      const data = await response.json();

      assert.strictEqual(response.status, 200);
      assert.ok(data.agent);
      assert.strictEqual(data.agent.urlKey, 'alice');
      assert.strictEqual(data.agent.name, 'Alice');
      // Ensure catalog peers has Company A data and excludes Company B
      if (data.catalog?.peerAgents && Array.isArray(data.catalog.peerAgents)) {
        // Must have Company A agents in catalog
        assert.ok(data.catalog.peerAgents.length > 0, 'Catalog peerAgents must not be empty');
        const hasAlice = data.catalog.peerAgents.some((a: any) => a.urlKey === 'alice');
        assert.ok(hasAlice, 'Company A agent alice must appear in catalog');
        // Must exclude Company B agent
        assert.ok(!data.catalog.peerAgents.some((a: any) => a.urlKey === 'charlie'), 
          'Company B agent charlie must not appear in Company A catalog');
      }
    });

    it('GET /api/mobile/approvals with tokenA excludes company B approvals', async () => {
      const tokenA = await tokenFor('company-a');
      const req = new NextRequest('http://localhost/api/mobile/approvals', {
        headers: { 'x-company-token': tokenA },
      });
      const response = await getApprovals(req);
      const data = await response.json();

      assert.strictEqual(response.status, 200);
      assert.ok(Array.isArray(data.approvals));
      // Must have Company A data to be a valid test
      const hasCompanyA = data.approvals.some((a: any) => a.id === 'approval-a1');
      assert.ok(hasCompanyA, 'Company A approval must be present in results');
      // Must exclude Company B data
      const hasCompanyB = data.approvals.some((a: any) => a.id === 'approval-b1');
      assert.ok(!hasCompanyB, 'Company B approval must not appear in Company A results');
    });

    it('GET /api/mobile/projects with tokenA excludes company B projects', async () => {
      const tokenA = await tokenFor('company-a');
      const req = new NextRequest('http://localhost/api/mobile/projects', {
        headers: { 'x-company-token': tokenA },
      });
      const response = await getProjects(req);
      const data = await response.json();

      assert.strictEqual(response.status, 200);
      assert.ok(Array.isArray(data.projects));
      // Must have Company A data to be a valid test
      const hasCompanyA = data.projects.some((p: any) => p.id === 'project-a1');
      assert.ok(hasCompanyA, 'Company A project must be present in results');
      // Must exclude Company B data
      const hasCompanyB = data.projects.some((p: any) => p.id === 'project-b1');
      assert.ok(!hasCompanyB, 'Company B project must not appear in Company A results');
    });

    it('GET /api/mobile/goals with tokenA excludes company B goals', async () => {
      const tokenA = await tokenFor('company-a');
      const req = new NextRequest('http://localhost/api/mobile/goals', {
        headers: { 'x-company-token': tokenA },
      });
      const response = await getGoals(req);
      const data = await response.json();

      assert.strictEqual(response.status, 200);
      assert.ok(Array.isArray(data.goals));
      // Must have Company A data to be a valid test
      const hasCompanyA = data.goals.some((g: any) => g.id === 'goal-a1');
      assert.ok(hasCompanyA, 'Company A goal must be present in results');
      // Must exclude Company B data
      const hasCompanyB = data.goals.some((g: any) => g.id === 'goal-b1');
      assert.ok(!hasCompanyB, 'Company B goal must not appear in Company A results');
    });

    it('GET /api/mobile/settings with tokenA returns company A data only', async () => {
      const tokenA = await tokenFor('company-a');
      const req = new NextRequest('http://localhost/api/mobile/settings', {
        headers: { 'x-company-token': tokenA },
      });
      const response = await getSettings(req);
      const data = await response.json();

      assert.strictEqual(response.status, 200);
      assert.ok(data.company);
      assert.strictEqual(data.company.id, 'company-a');
      assert.strictEqual(data.company.name, 'Company A');
      assert.notStrictEqual(data.company.id, 'company-b');
    });
  });
});
