import { NextRequest, NextResponse } from 'next/server';
import { verifyMobileToken } from '@/lib/mobile-auth';
import {
  setAgentActive,
  updateAgentRuntimeConfig,
  updateAgentObservationalMemory,
  type UpdateAgentObservationalMemoryInput,
} from '@/lib/agents';
import { db, agents, llmProviders, companies } from '@tourbillon/db';
import { eq } from 'drizzle-orm';
import { getHeartbeatList, getHeartbeatRun } from '@/lib/heartbeats';
import { listObservabilityEvents } from '@/lib/observability';
import { getJobLiveSnapshot } from '@/lib/jobs';

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
    name: 'company_list',
    description: 'List companies this token can act as (returns the single company from the JWT)',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'list_agents',
    description: 'List all agents in the company with their configuration (active status, heartbeat settings, observational memory mode)',
    inputSchema: {
      type: 'object',
      properties: {
        company_id: {
          type: 'string',
          description: 'Company ID (UUID)',
        },
      },
      required: ['company_id'],
    },
  },
  {
    name: 'set_agent_active',
    description: 'Set an agent active (true) or paused (false)',
    inputSchema: {
      type: 'object',
      properties: {
        company_id: {
          type: 'string',
          description: 'Company ID (UUID)',
        },
        agent_id: {
          type: 'string',
          description: 'The agent ID (UUID)',
        },
        active: {
          type: 'boolean',
          description: 'True to activate, false to pause',
        },
      },
      required: ['company_id', 'agent_id', 'active'],
    },
  },
  {
    name: 'set_heartbeat',
    description: 'Configure agent heartbeat timer (interval in seconds, cron schedule, or disable)',
    inputSchema: {
      type: 'object',
      properties: {
        company_id: {
          type: 'string',
          description: 'Company ID (UUID)',
        },
        agent_id: {
          type: 'string',
          description: 'The agent ID (UUID)',
        },
        enabled: {
          type: 'boolean',
          description: 'Enable or disable heartbeat timer',
        },
        interval_sec: {
          type: 'number',
          description: 'Heartbeat interval in seconds (if enabled and using interval mode)',
        },
        cron_expression: {
          type: 'string',
          description: 'Cron schedule (if enabled and using cron mode)',
        },
      },
      required: ['company_id', 'agent_id'],
    },
  },
  {
    name: 'set_om',
    description: 'Set agent observational memory mode (inherit, off, or on)',
    inputSchema: {
      type: 'object',
      properties: {
        company_id: {
          type: 'string',
          description: 'Company ID (UUID)',
        },
        agent_id: {
          type: 'string',
          description: 'The agent ID (UUID)',
        },
        mode: {
          type: 'string',
          enum: ['inherit', 'off', 'on'],
          description: 'Observational memory mode',
        },
        provider_id: {
          type: 'string',
          description: 'LLM provider ID (required if mode=on and not inheriting)',
        },
        model_id: {
          type: 'string',
          description: 'Model ID (required if mode=on and not inheriting)',
        },
      },
      required: ['company_id', 'agent_id', 'mode'],
    },
  },
  {
    name: 'list_failed_jobs',
    description: 'List recent failed heartbeat runs with error details',
    inputSchema: {
      type: 'object',
      properties: {
        company_id: {
          type: 'string',
          description: 'Company ID (UUID)',
        },
        page: {
          type: 'number',
          description: 'Page number (0-based)',
        },
        page_size: {
          type: 'number',
          description: 'Number of items per page (default 25)',
        },
      },
      required: ['company_id'],
    },
  },
  {
    name: 'get_heartbeat',
    description: 'Get heartbeat run details (status, agent, model, provider, source, timing, tokens, error)',
    inputSchema: {
      type: 'object',
      properties: {
        company_id: {
          type: 'string',
          description: 'Company ID (UUID)',
        },
        run_id: {
          type: 'string',
          description: 'Heartbeat run ID (UUID)',
        },
      },
      required: ['company_id', 'run_id'],
    },
  },
  {
    name: 'list_heartbeat_events',
    description: 'List observability events for a heartbeat run (time, type, name, duration, tokens, status, preview, errorInfo)',
    inputSchema: {
      type: 'object',
      properties: {
        company_id: {
          type: 'string',
          description: 'Company ID (UUID)',
        },
        run_id: {
          type: 'string',
          description: 'Heartbeat run ID (UUID)',
        },
        page: {
          type: 'number',
          description: 'Page number (0-based, default 0)',
        },
        page_size: {
          type: 'number',
          description: 'Items per page (default 25)',
        },
      },
      required: ['company_id', 'run_id'],
    },
  },
  {
    name: 'live_heartbeat',
    description: 'Get live snapshot of a heartbeat run (status, timing, logs, poll until settled)',
    inputSchema: {
      type: 'object',
      properties: {
        company_id: {
          type: 'string',
          description: 'Company ID (UUID)',
        },
        run_id: {
          type: 'string',
          description: 'Heartbeat run ID (UUID)',
        },
      },
      required: ['company_id', 'run_id'],
    },
  },
];

function validateCompanyAccess(tokenCompanyId: string, requestedCompanyId: string) {
  if (tokenCompanyId !== requestedCompanyId) {
    throw new Error('Company not found');
  }
}

async function handleCompanyList(tokenCompanyId: string) {
  const company = await db.query.companies.findFirst({
    where: eq(companies.id, tokenCompanyId),
  });

  if (!company) {
    return { companies: [] };
  }

  return {
    companies: [
      {
        id: company.id,
        name: company.name,
      },
    ],
  };
}

async function handleListAgents(tokenCompanyId: string, params: any) {
  const { company_id } = params;
  if (!company_id) {
    throw new Error('company_id is required');
  }
  validateCompanyAccess(tokenCompanyId, company_id);

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
    .where(eq(agents.companyId, company_id))
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
      heartbeatCronExpression: heartbeat.cronExpression ?? null,
      heartbeatScheduleMode: heartbeat.scheduleMode ?? null,
      observationalMemoryMode: observationalMemory.mode ?? 'inherit',
    };
  });
}

async function handleSetAgentActive(tokenCompanyId: string, params: any) {
  const { company_id, agent_id, active } = params;
  if (!company_id) {
    throw new Error('company_id is required');
  }
  if (!agent_id || typeof active !== 'boolean') {
    throw new Error('agent_id (string) and active (boolean) are required');
  }
  validateCompanyAccess(tokenCompanyId, company_id);

  const agent = await db.query.agents.findFirst({
    where: eq(agents.id, agent_id),
  });

  if (!agent) {
    throw new Error('Agent not found');
  }

  if (agent.companyId !== company_id) {
    throw new Error('Agent not found');
  }

  const updated = await setAgentActive(agent_id, active);
  return { success: true, status: updated.status };
}

async function handleSetHeartbeat(tokenCompanyId: string, params: any) {
  const { company_id, agent_id, enabled, interval_sec, cron_expression } = params;
  if (!company_id) {
    throw new Error('company_id is required');
  }
  if (!agent_id) {
    throw new Error('agent_id is required');
  }
  validateCompanyAccess(tokenCompanyId, company_id);

  const agent = await db.query.agents.findFirst({
    where: eq(agents.id, agent_id),
  });

  if (!agent) {
    throw new Error('Agent not found');
  }

  if (agent.companyId !== company_id) {
    throw new Error('Agent not found');
  }

  const heartbeatPatch: any = {};
  if (typeof enabled === 'boolean') {
    heartbeatPatch.enabled = enabled;
  }
  if (interval_sec !== undefined) {
    heartbeatPatch.intervalSec = interval_sec;
    heartbeatPatch.scheduleMode = 'interval';
  }
  if (cron_expression !== undefined) {
    heartbeatPatch.cronExpression = cron_expression;
    heartbeatPatch.scheduleMode = 'cron';
  }

  const updated = await updateAgentRuntimeConfig(agent_id, {
    heartbeat: heartbeatPatch,
  });

  const config = updated.runtimeConfig as any;
  const heartbeat = config?.heartbeat ?? {};

  return {
    success: true,
    heartbeatEnabled: heartbeat.enabled ?? false,
    heartbeatIntervalSec: heartbeat.intervalSec ?? null,
    heartbeatCronExpression: heartbeat.cronExpression ?? null,
    heartbeatScheduleMode: heartbeat.scheduleMode ?? null,
  };
}

async function handleSetOm(tokenCompanyId: string, params: any) {
  const { company_id, agent_id, mode, provider_id, model_id } = params;
  if (!company_id) {
    throw new Error('company_id is required');
  }
  if (!agent_id || !mode) {
    throw new Error('agent_id and mode are required');
  }
  validateCompanyAccess(tokenCompanyId, company_id);

  const agent = await db.query.agents.findFirst({
    where: eq(agents.id, agent_id),
  });

  if (!agent) {
    throw new Error('Agent not found');
  }

  if (agent.companyId !== company_id) {
    throw new Error('Agent not found');
  }

  const input: UpdateAgentObservationalMemoryInput = {
    mode,
    ...(provider_id && { providerId: provider_id }),
    ...(model_id && { modelId: model_id }),
  };

  const updated = await updateAgentObservationalMemory(agent_id, input);
  const config = updated.runtimeConfig as any;
  const observationalMemory = config?.observationalMemory ?? {};

  return {
    success: true,
    mode: observationalMemory.mode ?? 'inherit',
  };
}

async function handleListFailedJobs(tokenCompanyId: string, params: any) {
  const { company_id, page = 0, page_size = 25 } = params;
  if (!company_id) {
    throw new Error('company_id is required');
  }
  validateCompanyAccess(tokenCompanyId, company_id);

  const result = await getHeartbeatList({
    filter: 'failed',
    page,
    pageSize: page_size,
    companyId: company_id,
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

async function handleGetHeartbeat(tokenCompanyId: string, params: any) {
  const { company_id, run_id } = params;
  if (!company_id) {
    throw new Error('company_id is required');
  }
  if (!run_id) {
    throw new Error('run_id is required');
  }
  validateCompanyAccess(tokenCompanyId, company_id);

  const result = await getHeartbeatRun(run_id);
  if (!result) {
    throw new Error('Heartbeat run not found');
  }

  if (result.run.companyId !== company_id) {
    throw new Error('Heartbeat run not found');
  }

  const snapshot = result.run.contextSnapshot as any;
  const liveData = await getJobLiveSnapshot('heartbeat', run_id);

  return {
    runId: result.run.id,
    status: result.run.status,
    agentId: result.run.agentId,
    agentName: result.agent?.name ?? null,
    agentUrlKey: result.agent?.urlKey ?? null,
    modelId: snapshot?.modelId ?? result.agent?.modelId ?? null,
    providerName: snapshot?.providerName ?? result.agent?.providerName ?? null,
    invocationSource: result.run.invocationSource,
    startedAt: result.run.startedAt.toISOString(),
    lastSeenAt: result.run.lastSeenAt?.toISOString() ?? null,
    finishedAt: result.run.finishedAt?.toISOString() ?? null,
    errorText: result.run.errorText,
    inputTokens: liveData?.heartbeatRun?.contextSnapshot
      ? (liveData.heartbeatRun.contextSnapshot as any).inputTokens ?? null
      : null,
    outputTokens: liveData?.heartbeatRun?.contextSnapshot
      ? (liveData.heartbeatRun.contextSnapshot as any).outputTokens ?? null
      : null,
  };
}

async function handleListHeartbeatEvents(tokenCompanyId: string, params: any) {
  const { company_id, run_id, page = 0, page_size = 25 } = params;
  if (!company_id) {
    throw new Error('company_id is required');
  }
  if (!run_id) {
    throw new Error('run_id is required');
  }
  validateCompanyAccess(tokenCompanyId, company_id);

  const runCheck = await getHeartbeatRun(run_id);
  if (!runCheck) {
    throw new Error('Heartbeat run not found');
  }
  if (runCheck.run.companyId !== company_id) {
    throw new Error('Heartbeat run not found');
  }

  const result = await listObservabilityEvents({
    companyId: company_id,
    heartbeatRunId: run_id,
    page,
    pageSize: page_size,
  });

  return {
    events: result.events.map((event) => {
      const payload = event.payload as Record<string, unknown>;
      const errorInfo =
        payload.errorInfo && typeof payload.errorInfo === 'object' && !Array.isArray(payload.errorInfo)
          ? (payload.errorInfo as Record<string, unknown>)
          : null;

      return {
        id: event.id,
        occurredAt: event.occurredAt,
        eventType: event.eventType,
        name: event.name,
        status: event.status,
        durationMs: event.durationMs,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        inputPreview: event.inputPreview,
        outputPreview: event.outputPreview,
        errorText: event.errorText,
        errorInfo: errorInfo
          ? {
              statusCode: typeof errorInfo.statusCode === 'number' ? errorInfo.statusCode : null,
              url: typeof errorInfo.url === 'string' ? errorInfo.url : null,
              responseBody:
                typeof errorInfo.responseBody === 'string' ? errorInfo.responseBody : null,
              firstFrame:
                typeof errorInfo.first_frame === 'string' ? errorInfo.first_frame : null,
            }
          : null,
      };
    }),
    total: result.total,
    page: result.page,
    pageSize: result.pageSize,
  };
}

async function handleLiveHeartbeat(tokenCompanyId: string, params: any) {
  const { company_id, run_id } = params;
  if (!company_id) {
    throw new Error('company_id is required');
  }
  if (!run_id) {
    throw new Error('run_id is required');
  }
  validateCompanyAccess(tokenCompanyId, company_id);

  const runCheck = await getHeartbeatRun(run_id);
  if (!runCheck) {
    throw new Error('Heartbeat run not found');
  }
  if (runCheck.run.companyId !== company_id) {
    throw new Error('Heartbeat run not found');
  }

  const snapshot = await getJobLiveSnapshot('heartbeat', run_id);
  if (!snapshot) {
    throw new Error('Live snapshot not available');
  }

  return {
    runId: run_id,
    status: snapshot.heartbeatRun?.status ?? snapshot.state,
    state: snapshot.state,
    attemptsMade: snapshot.attemptsMade,
    startedAt: snapshot.heartbeatRun?.startedAt ?? null,
    lastSeenAt: snapshot.heartbeatRun?.lastSeenAt ?? null,
    finishedAt: snapshot.heartbeatRun?.finishedAt ?? null,
    errorText: snapshot.heartbeatRun?.errorText ?? null,
    logs: snapshot.logs,
    logCount: snapshot.count,
  };
}

async function handleToolCall(tokenCompanyId: string, toolName: string, params: any) {
  switch (toolName) {
    case 'company_list':
      return await handleCompanyList(tokenCompanyId);
    case 'list_agents':
      return await handleListAgents(tokenCompanyId, params);
    case 'set_agent_active':
      return await handleSetAgentActive(tokenCompanyId, params);
    case 'set_heartbeat':
      return await handleSetHeartbeat(tokenCompanyId, params);
    case 'set_om':
      return await handleSetOm(tokenCompanyId, params);
    case 'list_failed_jobs':
      return await handleListFailedJobs(tokenCompanyId, params);
    case 'get_heartbeat':
      return await handleGetHeartbeat(tokenCompanyId, params);
    case 'list_heartbeat_events':
      return await handleListHeartbeatEvents(tokenCompanyId, params);
    case 'live_heartbeat':
      return await handleLiveHeartbeat(tokenCompanyId, params);
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
  const companyId = await verifyMobileToken(req);
  
  const acceptHeader = req.headers.get('accept') || '';
  const wantsSSE = acceptHeader.includes('text/event-stream');

  if (wantsSSE && companyId) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        const sendEvent = (event: string, data: any) => {
          const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
          controller.enqueue(encoder.encode(message));
        };

        sendEvent('message', {
          jsonrpc: '2.0',
          method: 'initialized',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {
              tools: {},
            },
            serverInfo: {
              name: 'tourbillon-control-plane',
              version: '0.1.0',
            },
          },
        });

        const interval = setInterval(() => {
          sendEvent('ping', { timestamp: Date.now() });
        }, 30000);

        req.signal.addEventListener('abort', () => {
          clearInterval(interval);
          controller.close();
        });
      },
    });

    return new NextResponse(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  }

  return NextResponse.json(
    {
      name: 'tourbillon-control-plane',
      version: '0.1.0',
      description: 'Tourbillon control-plane MCP server for managing agents and heartbeats',
      protocol: 'mcp/http',
      transport: ['http', 'sse'],
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
