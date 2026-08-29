import { NextRequest, NextResponse } from 'next/server';
import { verifyMobileToken } from '@/lib/mobile-auth';
import {
  setAgentActive,
  updateAgentRuntimeConfig,
  updateAgentObservationalMemory,
  type UpdateAgentObservationalMemoryInput,
} from '@/lib/agents';
import { db, agents, llmProviders } from '@tourbillon/db';
import { eq } from 'drizzle-orm';
import { getHeartbeatList } from '@/lib/heartbeats';

interface McpRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: any;
}

interface McpResponse {
  jsonrpc: '2.0';
  id?: string | number;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
}

const MCP_TOOLS: McpTool[] = [
  {
    name: 'list_agents',
    description: 'List all agents in the company with their configuration (active status, heartbeat settings, observational memory mode)',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'set_agent_active',
    description: 'Set an agent active (true) or paused (false)',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: {
          type: 'string',
          description: 'The agent ID (UUID)',
        },
        active: {
          type: 'boolean',
          description: 'True to activate, false to pause',
        },
      },
      required: ['agentId', 'active'],
    },
  },
  {
    name: 'set_agent_heartbeat',
    description: 'Configure agent heartbeat timer (interval in seconds, cron schedule, or disable)',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: {
          type: 'string',
          description: 'The agent ID (UUID)',
        },
        enabled: {
          type: 'boolean',
          description: 'Enable or disable heartbeat timer',
        },
        intervalSec: {
          type: 'number',
          description: 'Heartbeat interval in seconds (if enabled and using interval mode)',
        },
        cron: {
          type: 'string',
          description: 'Cron schedule (if enabled and using cron mode)',
        },
      },
      required: ['agentId'],
    },
  },
  {
    name: 'set_agent_observational_memory',
    description: 'Set agent observational memory mode (inherit, off, or on)',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: {
          type: 'string',
          description: 'The agent ID (UUID)',
        },
        mode: {
          type: 'string',
          enum: ['inherit', 'off', 'on'],
          description: 'Observational memory mode',
        },
        providerId: {
          type: 'string',
          description: 'LLM provider ID (required if mode=on and not inheriting)',
        },
        modelId: {
          type: 'string',
          description: 'Model ID (required if mode=on and not inheriting)',
        },
      },
      required: ['agentId', 'mode'],
    },
  },
  {
    name: 'list_failed_heartbeats',
    description: 'List recent failed heartbeat runs with error details',
    inputSchema: {
      type: 'object',
      properties: {
        page: {
          type: 'number',
          description: 'Page number (0-based)',
        },
        pageSize: {
          type: 'number',
          description: 'Number of items per page (default 25)',
        },
      },
    },
  },
];

async function handleListAgents(companyId: string) {
  const rows = await db
    .select({
      id: agents.id,
      name: agents.name,
      urlKey: agents.urlKey,
      modelId: agents.modelId,
      status: agents.status,
      runtimeConfig: agents.runtimeConfig,
      providerName: llmProviders.name,
      providerType: llmProviders.type,
    })
    .from(agents)
    .leftJoin(llmProviders, eq(agents.providerId, llmProviders.id))
    .where(eq(agents.companyId, companyId))
    .orderBy(agents.name);

  return rows.map((a) => {
    const config = a.runtimeConfig as any;
    const heartbeat = config?.heartbeat ?? {};
    const observationalMemory = config?.observationalMemory ?? {};

    return {
      id: a.id,
      name: a.name,
      urlKey: a.urlKey,
      modelId: a.modelId ?? null,
      providerName: a.providerName ?? null,
      providerType: a.providerType ?? null,
      active: a.status === 'active',
      heartbeatEnabled: heartbeat.enabled ?? false,
      heartbeatIntervalSec: heartbeat.intervalSec ?? null,
      heartbeatCron: heartbeat.cron ?? null,
      observationalMemoryMode: observationalMemory.mode ?? 'inherit',
    };
  });
}

async function handleSetAgentActive(companyId: string, params: any) {
  const { agentId, active } = params;
  if (!agentId || typeof active !== 'boolean') {
    throw new Error('agentId (string) and active (boolean) are required');
  }

  const agent = await db.query.agents.findFirst({
    where: eq(agents.id, agentId),
  });

  if (!agent) {
    throw new Error('Agent not found');
  }

  if (agent.companyId !== companyId) {
    throw new Error('Agent does not belong to this company');
  }

  const updated = await setAgentActive(agentId, active);
  return { success: true, status: updated.status };
}

async function handleSetAgentHeartbeat(companyId: string, params: any) {
  const { agentId, enabled, intervalSec, cron } = params;
  if (!agentId) {
    throw new Error('agentId is required');
  }

  const agent = await db.query.agents.findFirst({
    where: eq(agents.id, agentId),
  });

  if (!agent) {
    throw new Error('Agent not found');
  }

  if (agent.companyId !== companyId) {
    throw new Error('Agent does not belong to this company');
  }

  const heartbeatPatch: any = {};
  if (typeof enabled === 'boolean') {
    heartbeatPatch.enabled = enabled;
  }
  if (intervalSec !== undefined) {
    heartbeatPatch.intervalSec = intervalSec;
  }
  if (cron !== undefined) {
    heartbeatPatch.cron = cron;
  }

  const updated = await updateAgentRuntimeConfig(agentId, {
    heartbeat: heartbeatPatch,
  });

  const config = updated.runtimeConfig as any;
  const heartbeat = config?.heartbeat ?? {};

  return {
    success: true,
    heartbeatEnabled: heartbeat.enabled ?? false,
    heartbeatIntervalSec: heartbeat.intervalSec ?? null,
    heartbeatCron: heartbeat.cron ?? null,
  };
}

async function handleSetAgentObservationalMemory(companyId: string, params: any) {
  const { agentId, mode, providerId, modelId } = params;
  if (!agentId || !mode) {
    throw new Error('agentId and mode are required');
  }

  const agent = await db.query.agents.findFirst({
    where: eq(agents.id, agentId),
  });

  if (!agent) {
    throw new Error('Agent not found');
  }

  if (agent.companyId !== companyId) {
    throw new Error('Agent does not belong to this company');
  }

  const input: UpdateAgentObservationalMemoryInput = {
    mode,
    ...(providerId && { providerId }),
    ...(modelId && { modelId }),
  };

  const updated = await updateAgentObservationalMemory(agentId, input);
  const config = updated.runtimeConfig as any;
  const observationalMemory = config?.observationalMemory ?? {};

  return {
    success: true,
    mode: observationalMemory.mode ?? 'inherit',
  };
}

async function handleListFailedHeartbeats(companyId: string, params: any) {
  const page = params?.page ?? 0;
  const pageSize = params?.pageSize ?? 25;

  const result = await getHeartbeatList({
    filter: 'failed',
    page,
    pageSize,
    companyId,
  });

  return {
    entries: result.entries.map((entry) => ({
      runId: entry.runId,
      jobId: entry.jobId,
      agentName: entry.agent?.name ?? null,
      agentUrlKey: entry.agent?.urlKey ?? null,
      modelId: entry.modelId,
      providerName: entry.providerName,
      invocationSource: entry.invocationSource,
      errorText: entry.errorText,
      startedAt: entry.startedAt?.toISOString() ?? null,
      finishedAt: entry.finishedAt?.toISOString() ?? null,
    })),
    total: result.total,
    page: result.page,
    pageSize: result.pageSize,
  };
}

async function handleToolCall(companyId: string, toolName: string, params: any) {
  switch (toolName) {
    case 'list_agents':
      return await handleListAgents(companyId);
    case 'set_agent_active':
      return await handleSetAgentActive(companyId, params);
    case 'set_agent_heartbeat':
      return await handleSetAgentHeartbeat(companyId, params);
    case 'set_agent_observational_memory':
      return await handleSetAgentObservationalMemory(companyId, params);
    case 'list_failed_heartbeats':
      return await handleListFailedHeartbeats(companyId, params);
    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

export async function POST(req: NextRequest) {
  try {
    const companyId = await verifyMobileToken(req);
    if (!companyId) {
      return NextResponse.json(
        {
          jsonrpc: '2.0',
          error: {
            code: -32001,
            message: 'Unauthorized: valid X-Company-Token required',
          },
        },
        { status: 401 }
      );
    }

    const body: McpRequest = await req.json();

    if (body.jsonrpc !== '2.0') {
      return NextResponse.json({
        jsonrpc: '2.0',
        id: body.id,
        error: {
          code: -32600,
          message: 'Invalid Request: jsonrpc must be "2.0"',
        },
      });
    }

    switch (body.method) {
      case 'initialize': {
        const response: McpResponse = {
          jsonrpc: '2.0',
          id: body.id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: {
              tools: {},
            },
            serverInfo: {
              name: 'tourbillon-control-plane',
              version: '0.1.0',
            },
          },
        };
        return NextResponse.json(response);
      }

      case 'tools/list': {
        const response: McpResponse = {
          jsonrpc: '2.0',
          id: body.id,
          result: {
            tools: MCP_TOOLS,
          },
        };
        return NextResponse.json(response);
      }

      case 'tools/call': {
        const { name: toolName, arguments: toolArgs } = body.params || {};
        if (!toolName) {
          return NextResponse.json({
            jsonrpc: '2.0',
            id: body.id,
            error: {
              code: -32602,
              message: 'Invalid params: tool name required',
            },
          });
        }

        try {
          const result = await handleToolCall(companyId, toolName, toolArgs);
          const response: McpResponse = {
            jsonrpc: '2.0',
            id: body.id,
            result: {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result, null, 2),
                },
              ],
            },
          };
          return NextResponse.json(response);
        } catch (err) {
          return NextResponse.json({
            jsonrpc: '2.0',
            id: body.id,
            error: {
              code: -32000,
              message: err instanceof Error ? err.message : 'Tool execution failed',
            },
          });
        }
      }

      default: {
        return NextResponse.json({
          jsonrpc: '2.0',
          id: body.id,
          error: {
            code: -32601,
            message: `Method not found: ${body.method}`,
          },
        });
      }
    }
  } catch (err) {
    return NextResponse.json(
      {
        jsonrpc: '2.0',
        error: {
          code: -32700,
          message: 'Parse error',
        },
      },
      { status: 500 }
    );
  }
}

export async function GET(req: NextRequest) {
  return NextResponse.json(
    {
      name: 'tourbillon-control-plane',
      version: '0.1.0',
      description: 'Tourbillon control-plane MCP server for managing agents and heartbeats',
      protocol: 'mcp/http',
      transport: 'http',
      endpoint: '/api/mcp',
      authentication: {
        type: 'header',
        header: 'X-Company-Token',
        description: 'JWT token with { companyId } payload, signed with BETTER_AUTH_SECRET',
      },
      capabilities: {
        tools: MCP_TOOLS.map((t) => t.name),
      },
    },
    {
      headers: {
        'Content-Type': 'application/json',
      },
    }
  );
}
