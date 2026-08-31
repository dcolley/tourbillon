import { NextRequest, NextResponse } from 'next/server';
import { db, agents, type Agent } from '@tourbillon/db';
import { eq } from 'drizzle-orm';
import {
  GRANULAR_TOOL_GROUPS,
  SKILL_CATALOG,
  TOOLSET_CATALOG,
  type AgentRuntimeConfig,
} from '@tourbillon/shared';
import { listToggleableMcpServerDefinitions } from '@tourbillon/shared/mcp-registry';
import {
  AGENT_ROLE_OPTIONS,
  AgentValidationError,
  deleteAgent,
  getAgentByUrlKey,
  setAgentActive,
  updateAgentAssignedToolsets,
  updateAgentBudget,
  updateAgentCapabilities,
  updateAgentCodeExecution,
  updateAgentInstructions,
  updateAgentModel,
  updateAgentModelSettings,
  updateAgentObservationalMemory,
  updateAgentProfile,
  updateAgentRole,
  updateAgentRuntimeConfig,
} from '@/lib/agents';
import { listLlmProvidersPublic } from '@/lib/llm-providers';
import { requireMobileCompany, toJson } from '@/lib/mobile-session';

function serializeAgent(agent: Agent) {
  const runtime = (agent.runtimeConfig ?? {}) as AgentRuntimeConfig;
  const { tavilyApiKey, searxngApiKey, searxngUrl, mcpCredentials, ...safeRuntime } = runtime;
  return {
    id: agent.id,
    name: agent.name,
    title: agent.title,
    role: agent.role,
    urlKey: agent.urlKey,
    status: agent.status,
    reportsToId: agent.reportsToId,
    modelId: agent.modelId,
    providerId: agent.providerId,
    adapterType: agent.adapterType,
    assignedSkills: agent.assignedSkills ?? [],
    assignedToolsets: agent.assignedToolsets ?? [],
    mcpServerIds: agent.mcpServerIds ?? [],
    budgetMonthlyTokens: agent.budgetMonthlyTokens,
    spentMonthlyTokens: agent.spentMonthlyTokens,
    instructionsBundleSoulMd: agent.instructionsBundleSoulMd,
    instructionsBundleAgentsMd: agent.instructionsBundleAgentsMd,
    runtimeConfig: safeRuntime,
    secrets: {
      hasTavilyApiKey: Boolean(tavilyApiKey),
      hasSearxngApiKey: Boolean(searxngApiKey),
      hasSearxngUrl: Boolean(searxngUrl),
      hasBufferApiKey: Boolean(mcpCredentials?.['buffer-mcp']),
    },
    createdAt: agent.createdAt instanceof Date ? agent.createdAt.toISOString() : agent.createdAt,
    updatedAt: agent.updatedAt instanceof Date ? agent.updatedAt.toISOString() : agent.updatedAt,
  };
}

async function buildCatalog(companyId: string, allowedMcpServerIds: string[] | null) {
  const [providers, peers] = await Promise.all([
    listLlmProvidersPublic(),
    db
      .select({
        id: agents.id,
        name: agents.name,
        urlKey: agents.urlKey,
        role: agents.role,
      })
      .from(agents)
      .where(eq(agents.companyId, companyId)),
  ]);

  return {
    roles: AGENT_ROLE_OPTIONS,
    skills: SKILL_CATALOG,
    toolsets: TOOLSET_CATALOG,
    assignableTools: GRANULAR_TOOL_GROUPS,
    mcpServers: listToggleableMcpServerDefinitions(allowedMcpServerIds ?? []).map((s) => ({
      id: s.id,
      name: s.label ?? s.id,
    })),
    providers: providers.map((p) => ({
      id: p.id,
      name: p.name,
      type: p.type,
      isDefault: p.isDefault,
    })),
    peerAgents: peers,
  };
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ urlKey: string }> },
) {
  const auth = await requireMobileCompany(req);
  if ('error' in auth) return auth.error;

  try {
    const { urlKey } = await params;
    const agent = await getAgentByUrlKey(decodeURIComponent(urlKey), auth.company.id);
    if (!agent) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    const catalog = await buildCatalog(auth.company.id, auth.company.allowedMcpServerIds ?? []);
    return NextResponse.json({
      agent: serializeAgent(agent),
      catalog,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load agent';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

type PatchBody = {
  section?: string;
} & Record<string, unknown>;

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ urlKey: string }> },
) {
  const auth = await requireMobileCompany(req);
  if ('error' in auth) return auth.error;

  try {
    const { urlKey } = await params;
    const agent = await getAgentByUrlKey(decodeURIComponent(urlKey), auth.company.id);
    if (!agent) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const body = (await req.json()) as PatchBody;
    const section = typeof body.section === 'string' ? body.section : '';
    let updated = agent;

    switch (section) {
      case 'profile':
        updated = await updateAgentProfile(agent.id, {
          name: String(body.name ?? ''),
          urlKey: String(body.urlKey ?? ''),
          reportsToId: (body.reportsToId as string | null | undefined) ?? null,
        });
        break;
      case 'role':
        updated = await updateAgentRole(agent.id, String(body.role ?? ''));
        break;
      case 'instructions':
        updated = await updateAgentInstructions(agent.id, {
          soulMd: typeof body.soulMd === 'string' ? body.soulMd : undefined,
          agentsMd: typeof body.agentsMd === 'string' ? body.agentsMd : undefined,
        });
        break;
      case 'model':
        updated = await updateAgentModel(agent.id, {
          modelId: String(body.modelId ?? ''),
          providerId: (body.providerId as string | null | undefined) ?? null,
        });
        break;
      case 'modelSettings':
        updated = await updateAgentModelSettings(agent.id, {
          temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
          maxOutputTokens: typeof body.maxOutputTokens === 'number' ? body.maxOutputTokens : undefined,
        });
        break;
      case 'codeExecution':
        updated = await updateAgentCodeExecution(agent.id, {
          runtimeType: body.runtimeType === 'harness' ? 'harness' : 'agent',
          codeExecutionEnabled: body.codeExecutionEnabled === true,
          timeoutMs: typeof body.timeoutMs === 'number' ? body.timeoutMs : null,
          isolation: typeof body.isolation === 'string' ? body.isolation : null,
          clearCodeExecutionOverrides: body.clearCodeExecutionOverrides === true,
        });
        break;
      case 'heartbeat':
        updated = await updateAgentRuntimeConfig(agent.id, {
          heartbeat: {
            enabled: body.enabled === true,
            intervalSec: typeof body.intervalSec === 'number' ? body.intervalSec : undefined,
            cronExpression: typeof body.cronExpression === 'string' ? body.cronExpression : undefined,
            maxSteps: typeof body.maxSteps === 'number' ? body.maxSteps : undefined,
          },
          timeout: {
            heartbeatSec: typeof body.heartbeatSec === 'number' ? body.heartbeatSec : undefined,
          },
        });
        break;
      case 'capabilities':
        updated = await updateAgentCapabilities(agent.id, {
          toolsets: Array.isArray(body.toolsets) ? body.toolsets.map(String) : agent.assignedToolsets ?? [],
          assignedTools: Array.isArray(body.assignedTools)
            ? body.assignedTools.map(String)
            : ((agent.runtimeConfig as AgentRuntimeConfig)?.assignedTools ?? []),
          assignedSkills: Array.isArray(body.assignedSkills)
            ? body.assignedSkills.map(String)
            : agent.assignedSkills ?? [],
          mcpServerIds: Array.isArray(body.mcpServerIds) ? body.mcpServerIds.map(String) : undefined,
        });
        break;
      case 'toolsets':
        updated = await updateAgentAssignedToolsets(
          agent.id,
          Array.isArray(body.toolsets) ? body.toolsets.map(String) : [],
        );
        break;
      case 'budget':
        updated = await updateAgentBudget(agent.id, {
          budgetMonthlyTokens: Number(body.budgetMonthlyTokens ?? 0),
          enforce: body.enforce === true,
        });
        break;
      case 'om':
        updated = await updateAgentObservationalMemory(agent.id, {
          mode: (body.mode as 'inherit' | 'off' | 'on') ?? 'inherit',
          providerId: typeof body.providerId === 'string' ? body.providerId : undefined,
          modelId: typeof body.modelId === 'string' ? body.modelId : undefined,
          maxOutputTokens: typeof body.maxOutputTokens === 'number' ? body.maxOutputTokens : undefined,
          observeAfterTokens:
            typeof body.observeAfterTokens === 'number' ? body.observeAfterTokens : undefined,
          reflectAfterTokens:
            typeof body.reflectAfterTokens === 'number' ? body.reflectAfterTokens : undefined,
          temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
        });
        break;
      case 'active':
        updated = await setAgentActive(agent.id, body.active === true);
        break;
      case 'delete':
        await deleteAgent(agent.id, String(body.confirmUrlKey ?? ''));
        return NextResponse.json({ deleted: true });
      default:
        return NextResponse.json({ error: `Unknown section: ${section}` }, { status: 400 });
    }

    return NextResponse.json({ agent: toJson(serializeAgent(updated)) });
  } catch (err) {
    if (err instanceof AgentValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    const message = err instanceof Error ? err.message : 'Failed to update agent';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
