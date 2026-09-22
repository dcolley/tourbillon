import { NextRequest, NextResponse } from 'next/server';
import { verifyMobileToken } from '@/lib/mobile-auth';
import {
  setAgentActive,
  updateAgentRuntimeConfig,
  updateAgentObservationalMemory,
  type UpdateAgentObservationalMemoryInput,
} from '@/lib/agents';
import { db, agents, llmProviders, companies, issues, goals, projects, approvals } from '@tourbillon/db';
import { and, eq, inArray, desc } from 'drizzle-orm';
import { getHeartbeatList, getHeartbeatRun } from '@/lib/heartbeats';
import { listObservabilityEvents } from '@/lib/observability';
import { getJobLiveSnapshot } from '@/lib/jobs';
import { createIssue, updateIssue, getIssueDetail, listIssues, type CreateIssueInput } from '@/lib/issues';
import { createGoal, updateGoal, listGoalsForCompany, type CreateGoalInput, type UpdateGoalInput } from '@/lib/goals';
import { createProject, updateProject, listProjectsForAgent, type CreateProjectInput, type UpdateProjectInput } from '@/lib/projects';
import { addIssueComment } from '@/lib/issue-comments';
import { triggerAgentHeartbeat } from '@/lib/heartbeat';
import { enqueueApprovalWake } from '@/lib/wake-client';

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
  {
    name: 'list_issues',
    description: 'List issues in the company with optional status and assignee filters',
    inputSchema: {
      type: 'object',
      properties: {
        company_id: {
          type: 'string',
          description: 'Company ID (UUID)',
        },
        status: {
          type: 'string',
          description: 'Filter by status (backlog, todo, in_progress, in_review, done, blocked, cancelled). Omit for all.',
        },
        assignee_agent_id: {
          type: 'string',
          description: 'Filter by assigned agent ID (UUID)',
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
      required: ['company_id'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get issue detail (title, description, status, priority, assignee, goal, project, comments)',
    inputSchema: {
      type: 'object',
      properties: {
        company_id: {
          type: 'string',
          description: 'Company ID (UUID)',
        },
        issue_id: {
          type: 'string',
          description: 'Issue ID (UUID)',
        },
      },
      required: ['company_id', 'issue_id'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create a new issue. Empty creates are rejected.',
    inputSchema: {
      type: 'object',
      properties: {
        company_id: {
          type: 'string',
          description: 'Company ID (UUID)',
        },
        title: {
          type: 'string',
          description: 'Issue title (required)',
        },
        description: {
          type: 'string',
          description: 'Issue description',
        },
        assignee_agent_id: {
          type: 'string',
          description: 'Agent ID to assign (UUID)',
        },
        goal_id: {
          type: 'string',
          description: 'Goal ID (UUID)',
        },
        project_id: {
          type: 'string',
          description: 'Project ID (UUID)',
        },
        priority: {
          type: 'string',
          enum: ['critical', 'high', 'medium', 'low'],
          description: 'Issue priority (default: medium)',
        },
      },
      required: ['company_id', 'title'],
    },
  },
  {
    name: 'set_issue_status',
    description: 'Set issue status (backlog, todo, in_progress, in_review, done, blocked, cancelled). Halted issues cannot change until board decides.',
    inputSchema: {
      type: 'object',
      properties: {
        company_id: {
          type: 'string',
          description: 'Company ID (UUID)',
        },
        issue_id: {
          type: 'string',
          description: 'Issue ID (UUID)',
        },
        status: {
          type: 'string',
          enum: ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'blocked', 'cancelled'],
          description: 'New status',
        },
      },
      required: ['company_id', 'issue_id', 'status'],
    },
  },
  {
    name: 'add_issue_comment',
    description: 'Add a comment to an issue',
    inputSchema: {
      type: 'object',
      properties: {
        company_id: {
          type: 'string',
          description: 'Company ID (UUID)',
        },
        issue_id: {
          type: 'string',
          description: 'Issue ID (UUID)',
        },
        body: {
          type: 'string',
          description: 'Comment text',
        },
      },
      required: ['company_id', 'issue_id', 'body'],
    },
  },
  {
    name: 'list_goals',
    description: 'List goals in the company',
    inputSchema: {
      type: 'object',
      properties: {
        company_id: {
          type: 'string',
          description: 'Company ID (UUID)',
        },
        status: {
          type: 'string',
          enum: ['active', 'completed', 'archived', 'all'],
          description: 'Filter by status (default: all)',
        },
      },
      required: ['company_id'],
    },
  },
  {
    name: 'create_goal',
    description: 'Create a new goal',
    inputSchema: {
      type: 'object',
      properties: {
        company_id: {
          type: 'string',
          description: 'Company ID (UUID)',
        },
        title: {
          type: 'string',
          description: 'Goal title (required)',
        },
        description: {
          type: 'string',
          description: 'Goal description',
        },
        status: {
          type: 'string',
          enum: ['active', 'completed', 'archived'],
          description: 'Goal status (default: active)',
        },
      },
      required: ['company_id', 'title'],
    },
  },
  {
    name: 'set_goal_status',
    description: 'Set goal status (active, completed, archived)',
    inputSchema: {
      type: 'object',
      properties: {
        company_id: {
          type: 'string',
          description: 'Company ID (UUID)',
        },
        goal_id: {
          type: 'string',
          description: 'Goal ID (UUID)',
        },
        status: {
          type: 'string',
          enum: ['active', 'completed', 'archived'],
          description: 'New status',
        },
      },
      required: ['company_id', 'goal_id', 'status'],
    },
  },
  {
    name: 'list_projects',
    description: 'List projects in the company',
    inputSchema: {
      type: 'object',
      properties: {
        company_id: {
          type: 'string',
          description: 'Company ID (UUID)',
        },
        status: {
          type: 'string',
          enum: ['active', 'paused', 'completed', 'archived', 'all'],
          description: 'Filter by status (default: all)',
        },
        goal_id: {
          type: 'string',
          description: 'Filter by goal ID (UUID)',
        },
      },
      required: ['company_id'],
    },
  },
  {
    name: 'create_project',
    description: 'Create a new project',
    inputSchema: {
      type: 'object',
      properties: {
        company_id: {
          type: 'string',
          description: 'Company ID (UUID)',
        },
        title: {
          type: 'string',
          description: 'Project title (required)',
        },
        description: {
          type: 'string',
          description: 'Project description',
        },
        goal_id: {
          type: 'string',
          description: 'Goal ID (UUID, required)',
        },
        status: {
          type: 'string',
          enum: ['active', 'paused', 'completed', 'archived'],
          description: 'Project status (default: active)',
        },
      },
      required: ['company_id', 'title', 'goal_id'],
    },
  },
  {
    name: 'set_project_status',
    description: 'Set project status (active, paused, completed, archived)',
    inputSchema: {
      type: 'object',
      properties: {
        company_id: {
          type: 'string',
          description: 'Company ID (UUID)',
        },
        project_id: {
          type: 'string',
          description: 'Project ID (UUID)',
        },
        status: {
          type: 'string',
          enum: ['active', 'paused', 'completed', 'archived'],
          description: 'New status',
        },
      },
      required: ['company_id', 'project_id', 'status'],
    },
  },
  {
    name: 'list_approvals',
    description: 'List pending and recent board approvals',
    inputSchema: {
      type: 'object',
      properties: {
        company_id: {
          type: 'string',
          description: 'Company ID (UUID)',
        },
        status: {
          type: 'string',
          enum: ['pending', 'approved', 'rejected', 'all'],
          description: 'Filter by status (default: pending)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (default: 50)',
        },
      },
      required: ['company_id'],
    },
  },
  {
    name: 'decide_approval',
    description: 'Decide a pending board approval (approve or reject). Reject restores blocked status; issues must be manually cancelled via set_issue_status if needed.',
    inputSchema: {
      type: 'object',
      properties: {
        company_id: {
          type: 'string',
          description: 'Company ID (UUID)',
        },
        approval_id: {
          type: 'string',
          description: 'Approval ID (UUID)',
        },
        decision: {
          type: 'string',
          enum: ['approved', 'rejected'],
          description: 'Decision (approved or rejected)',
        },
        reason: {
          type: 'string',
          description: 'Decision reason/note',
        },
      },
      required: ['company_id', 'approval_id', 'decision'],
    },
  },
  {
    name: 'wake_agent',
    description: 'Trigger on-demand agent heartbeat. Returns in-flight error if a wake is already running.',
    inputSchema: {
      type: 'object',
      properties: {
        company_id: {
          type: 'string',
          description: 'Company ID (UUID)',
        },
        agent_id: {
          type: 'string',
          description: 'Agent ID (UUID)',
        },
      },
      required: ['company_id', 'agent_id'],
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

async function handleListIssues(tokenCompanyId: string, params: any) {
  const { company_id, status, assignee_agent_id, page = 0, page_size = 25 } = params;
  if (!company_id) {
    throw new Error('company_id is required');
  }
  validateCompanyAccess(tokenCompanyId, company_id);

  const statuses = status ? [status] : ['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled'];
  
  const result = await listIssues({
    statuses,
    page,
    pageSize: page_size,
    companyIdOverride: company_id,
  });

  return {
    issues: result.rows.map(r => ({
      id: r.issue.id,
      identifier: r.issue.identifier,
      title: r.issue.title,
      description: r.issue.description,
      status: r.issue.status,
      priority: r.issue.priority,
      assigneeAgentId: r.issue.assigneeAgentId,
      assigneeUserId: r.issue.assigneeUserId,
      goalId: r.issue.goalId,
      projectId: r.issue.projectId,
      createdAt: r.issue.createdAt.toISOString(),
      updatedAt: r.issue.updatedAt.toISOString(),
    })),
    total: result.total,
    page: result.page,
    pageSize: result.pageSize,
  };
}

async function handleGetIssue(tokenCompanyId: string, params: any) {
  const { company_id, issue_id } = params;
  if (!company_id) {
    throw new Error('company_id is required');
  }
  if (!issue_id) {
    throw new Error('issue_id is required');
  }
  validateCompanyAccess(tokenCompanyId, company_id);

  const detail = await getIssueDetail(issue_id);
  if (!detail) {
    throw new Error('Issue not found');
  }
  if (detail.issue.companyId !== company_id) {
    throw new Error('Issue not found');
  }

  return {
    id: detail.issue.id,
    identifier: detail.issue.identifier,
    title: detail.issue.title,
    description: detail.issue.description,
    status: detail.issue.status,
    priority: detail.issue.priority,
    assigneeAgentId: detail.issue.assigneeAgentId,
    assigneeUserId: detail.issue.assigneeUserId,
    goalId: detail.issue.goalId,
    projectId: detail.issue.projectId,
    assignee: detail.assignee,
    goal: detail.goal,
    project: detail.project,
    createdAt: detail.issue.createdAt.toISOString(),
    updatedAt: detail.issue.updatedAt.toISOString(),
  };
}

async function handleCreateIssue(tokenCompanyId: string, params: any) {
  const { company_id, title, description, assignee_agent_id, goal_id, project_id, priority } = params;
  if (!company_id) {
    throw new Error('company_id is required');
  }
  if (!title || !title.trim()) {
    throw new Error('title is required');
  }
  validateCompanyAccess(tokenCompanyId, company_id);

  const input: CreateIssueInput = {
    title,
    description,
    assigneeAgentId: assignee_agent_id,
    goalId: goal_id,
    projectId: project_id,
    priority,
    companyId: company_id,
    createdBy: { type: 'user', id: 'mcp', name: 'MCP' },
  };

  const created = await createIssue(input);
  return {
    id: created.id,
    identifier: created.identifier,
    title: created.title,
    status: created.status,
    priority: created.priority,
  };
}

async function handleSetIssueStatus(tokenCompanyId: string, params: any) {
  const { company_id, issue_id, status } = params;
  if (!company_id) {
    throw new Error('company_id is required');
  }
  if (!issue_id || !status) {
    throw new Error('issue_id and status are required');
  }
  validateCompanyAccess(tokenCompanyId, company_id);

  const issue = await db.query.issues.findFirst({
    where: eq(issues.id, issue_id),
  });

  if (!issue) {
    throw new Error('Issue not found');
  }
  if (issue.companyId !== company_id) {
    throw new Error('Issue not found');
  }

  const updated = await updateIssue(issue_id, { status });
  return {
    id: updated.id,
    identifier: updated.identifier,
    status: updated.status,
  };
}

async function handleAddIssueComment(tokenCompanyId: string, params: any) {
  const { company_id, issue_id, body } = params;
  if (!company_id) {
    throw new Error('company_id is required');
  }
  if (!issue_id || !body) {
    throw new Error('issue_id and body are required');
  }
  validateCompanyAccess(tokenCompanyId, company_id);

  const issue = await db.query.issues.findFirst({
    where: eq(issues.id, issue_id),
  });

  if (!issue) {
    throw new Error('Issue not found');
  }
  if (issue.companyId !== company_id) {
    throw new Error('Issue not found');
  }

  const comment = await addIssueComment(
    issue_id,
    company_id,
    { type: 'user', id: 'mcp', name: 'MCP' },
    body
  );

  return {
    id: comment.id,
    body: comment.body,
    createdAt: comment.createdAt,
  };
}

async function handleListGoals(tokenCompanyId: string, params: any) {
  const { company_id, status = 'all' } = params;
  if (!company_id) {
    throw new Error('company_id is required');
  }
  validateCompanyAccess(tokenCompanyId, company_id);

  const rows = await listGoalsForCompany(company_id, status);
  return {
    goals: rows.map(g => ({
      id: g.id,
      title: g.title,
      description: g.description,
      status: g.status,
      createdAt: g.createdAt.toISOString(),
      updatedAt: g.updatedAt.toISOString(),
    })),
  };
}

async function handleCreateGoal(tokenCompanyId: string, params: any) {
  const { company_id, title, description, status } = params;
  if (!company_id) {
    throw new Error('company_id is required');
  }
  if (!title || !title.trim()) {
    throw new Error('title is required');
  }
  validateCompanyAccess(tokenCompanyId, company_id);

  const input: CreateGoalInput = {
    title,
    description,
    status,
    companyId: company_id,
  };

  const created = await createGoal(input);
  return {
    id: created.id,
    title: created.title,
    status: created.status,
  };
}

async function handleSetGoalStatus(tokenCompanyId: string, params: any) {
  const { company_id, goal_id, status } = params;
  if (!company_id) {
    throw new Error('company_id is required');
  }
  if (!goal_id || !status) {
    throw new Error('goal_id and status are required');
  }
  validateCompanyAccess(tokenCompanyId, company_id);

  const goal = await db.query.goals.findFirst({
    where: eq(goals.id, goal_id),
  });

  if (!goal) {
    throw new Error('Goal not found');
  }
  if (goal.companyId !== company_id) {
    throw new Error('Goal not found');
  }

  const input: UpdateGoalInput = { status };
  const updated = await updateGoal(goal_id, input, company_id);
  return {
    id: updated.id,
    title: updated.title,
    status: updated.status,
  };
}

async function handleListProjects(tokenCompanyId: string, params: any) {
  const { company_id, status = 'all', goal_id } = params;
  if (!company_id) {
    throw new Error('company_id is required');
  }
  validateCompanyAccess(tokenCompanyId, company_id);

  const filters: any = {};
  if (status && status !== 'all') {
    filters.status = status;
  }
  if (goal_id) {
    filters.goalId = goal_id;
  }

  const rows = await listProjectsForAgent(company_id, filters);
  return {
    projects: rows.map(p => ({
      id: p.id,
      title: p.title,
      description: p.description,
      status: p.status,
      goalId: p.goalId,
      goalTitle: p.goalTitle,
    })),
  };
}

async function handleCreateProject(tokenCompanyId: string, params: any) {
  const { company_id, title, description, goal_id, status } = params;
  if (!company_id) {
    throw new Error('company_id is required');
  }
  if (!title || !title.trim()) {
    throw new Error('title is required');
  }
  if (!goal_id) {
    throw new Error('goal_id is required');
  }
  validateCompanyAccess(tokenCompanyId, company_id);

  const input: CreateProjectInput = {
    title,
    description,
    goalId: goal_id,
    status,
    companyId: company_id,
  };

  const created = await createProject(input);
  return {
    id: created.id,
    title: created.title,
    status: created.status,
    goalId: created.goalId,
  };
}

async function handleSetProjectStatus(tokenCompanyId: string, params: any) {
  const { company_id, project_id, status } = params;
  if (!company_id) {
    throw new Error('company_id is required');
  }
  if (!project_id || !status) {
    throw new Error('project_id and status are required');
  }
  validateCompanyAccess(tokenCompanyId, company_id);

  const project = await db.query.projects.findFirst({
    where: eq(projects.id, project_id),
  });

  if (!project) {
    throw new Error('Project not found');
  }
  if (project.companyId !== company_id) {
    throw new Error('Project not found');
  }

  const input: UpdateProjectInput = { status };
  const updated = await updateProject(project_id, input);
  return {
    id: updated.id,
    title: updated.title,
    status: updated.status,
  };
}

async function handleListApprovals(tokenCompanyId: string, params: any) {
  const { company_id, status = 'pending', limit = 50 } = params;
  if (!company_id) {
    throw new Error('company_id is required');
  }
  validateCompanyAccess(tokenCompanyId, company_id);

  const conditions = [eq(approvals.companyId, company_id)];
  if (status && status !== 'all') {
    conditions.push(eq(approvals.status, status));
  }

  const rows = await db
    .select()
    .from(approvals)
    .where(and(...conditions))
    .orderBy(desc(approvals.createdAt))
    .limit(limit);

  return {
    approvals: rows.map(a => ({
      id: a.id,
      type: a.type,
      status: a.status,
      requestedByAgentId: a.requestedByAgentId,
      decidedByUserId: a.decidedByUserId,
      issueIds: a.issueIds,
      payload: a.payload,
      note: a.note,
      decidedAt: a.decidedAt?.toISOString() ?? null,
      createdAt: a.createdAt.toISOString(),
    })),
  };
}

async function handleDecideApproval(tokenCompanyId: string, params: any) {
  const { company_id, approval_id, decision, reason } = params;
  if (!company_id) {
    throw new Error('company_id is required');
  }
  if (!approval_id || !decision) {
    throw new Error('approval_id and decision are required');
  }
  if (!['approved', 'rejected'].includes(decision)) {
    throw new Error('decision must be approved or rejected');
  }
  validateCompanyAccess(tokenCompanyId, company_id);

  const approval = await db.query.approvals.findFirst({
    where: eq(approvals.id, approval_id),
  });

  if (!approval) {
    throw new Error('Approval not found');
  }
  if (approval.companyId !== company_id) {
    throw new Error('Approval not found');
  }
  if (approval.status !== 'pending') {
    throw new Error('Approval already decided');
  }

  const payload = (approval.payload ?? {}) as any;
  const priorStatuses = payload.priorStatuses ?? {};
  const issueIds = approval.issueIds ?? [];

  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(approvals)
      .set({
        status: decision,
        note: reason,
        decidedAt: new Date(),
        decidedByUserId: 'mcp',
        updatedAt: new Date(),
      })
      .where(eq(approvals.id, approval_id))
      .returning();

    if (issueIds.length > 0) {
      const linked = await tx
        .select({
          id: issues.id,
          status: issues.status,
          boardApprovalId: issues.boardApprovalId,
        })
        .from(issues)
        .where(and(eq(issues.companyId, company_id), inArray(issues.id, issueIds)));

      const now = new Date();
      for (const issue of linked) {
        if (issue.boardApprovalId && issue.boardApprovalId !== approval_id) continue;

        const restoreStatus =
          decision === 'approved'
            ? (priorStatuses[issue.id] ?? (issue.status === 'blocked' ? 'todo' : issue.status))
            : 'blocked';

        await tx
          .update(issues)
          .set({
            status: restoreStatus,
            boardApprovalId: null,
            updatedAt: now,
          })
          .where(eq(issues.id, issue.id));
      }
    }

    return row;
  });

  // Trigger approval wake
  if (approval.requestedByAgentId) {
    try {
      await enqueueApprovalWake({
        approvalId: approval_id,
        agentId: approval.requestedByAgentId,
        companyId: company_id,
        status: decision,
        note: reason,
        linkedIssueIds: approval.issueIds,
      });
    } catch (err) {
      console.error('[mcp decide_approval] failed to trigger approval wake:', err);
    }
  }

  return {
    id: updated.id,
    status: updated.status,
    decision,
    decidedAt: updated.decidedAt?.toISOString() ?? null,
  };
}

async function handleWakeAgent(tokenCompanyId: string, params: any) {
  const { company_id, agent_id } = params;
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

  try {
    const result = await triggerAgentHeartbeat(agent_id, company_id);
    return {
      runId: result.runId,
      jobId: result.jobId,
      outcome: result.outcome,
      skipReason: result.skipReason ?? null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Wake failed';
    if (message.includes('a wake may already be in flight')) {
      throw new Error('a wake may already be in flight');
    }
    throw err;
  }
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
    case 'list_issues':
      return await handleListIssues(tokenCompanyId, params);
    case 'get_issue':
      return await handleGetIssue(tokenCompanyId, params);
    case 'create_issue':
      return await handleCreateIssue(tokenCompanyId, params);
    case 'set_issue_status':
      return await handleSetIssueStatus(tokenCompanyId, params);
    case 'add_issue_comment':
      return await handleAddIssueComment(tokenCompanyId, params);
    case 'list_goals':
      return await handleListGoals(tokenCompanyId, params);
    case 'create_goal':
      return await handleCreateGoal(tokenCompanyId, params);
    case 'set_goal_status':
      return await handleSetGoalStatus(tokenCompanyId, params);
    case 'list_projects':
      return await handleListProjects(tokenCompanyId, params);
    case 'create_project':
      return await handleCreateProject(tokenCompanyId, params);
    case 'set_project_status':
      return await handleSetProjectStatus(tokenCompanyId, params);
    case 'list_approvals':
      return await handleListApprovals(tokenCompanyId, params);
    case 'decide_approval':
      return await handleDecideApproval(tokenCompanyId, params);
    case 'wake_agent':
      return await handleWakeAgent(tokenCompanyId, params);
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
