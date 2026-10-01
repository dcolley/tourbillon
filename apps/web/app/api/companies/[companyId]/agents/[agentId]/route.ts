import { NextRequest, NextResponse } from 'next/server';
import { db, agents } from '@tourbillon/db';
import { and, eq } from 'drizzle-orm';
import { validateRunToken } from '@/lib/auth/run-token';
import {
  AgentValidationError,
  setAgentStatus,
  updateAgentRuntimeConfig,
  updateAgentProfile,
  updateAgentInstructions,
  updateAgentModel,
  updateAgentCapabilities,
  updateAgentObservationalMemory,
  type AgentStatus,
  type UpdateAgentObservationalMemoryInput,
} from '@/lib/agents';
import { normalizeHeartbeatConfig, validateHeartbeatSchedule } from '@tourbillon/shared';

function unauthorized() {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

function forbidden(message = 'Forbidden') {
  return NextResponse.json({ error: message }, { status: 403 });
}

function notFound(message = 'Agent not found') {
  return NextResponse.json({ error: message }, { status: 404 });
}

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

/**
 * Check if the capability update grants privileges the calling agent does not hold.
 * Privilege grants: code-execution toolset, new MCP servers, or any toolset the caller lacks.
 */
async function checkPrivilegeGrant(
  callerAgentId: string,
  companyId: string,
  patch: { assignedToolsets?: string[]; mcpServerIds?: string[] }
): Promise<boolean> {
  const caller = await db.query.agents.findFirst({
    where: and(eq(agents.id, callerAgentId), eq(agents.companyId, companyId)),
  });
  if (!caller) return false;

  const callerToolsets = new Set(caller.assignedToolsets ?? []);
  const callerMcpServers = new Set(caller.mcpServerIds ?? []);

  // Check if granting code-execution toolset (always privileged)
  if (patch.assignedToolsets?.includes('code-execution') && !callerToolsets.has('code-execution')) {
    return true;
  }

  // Check if granting any toolset the caller doesn't have
  if (patch.assignedToolsets) {
    for (const toolset of patch.assignedToolsets) {
      if (!callerToolsets.has(toolset)) {
        return true;
      }
    }
  }

  // Check if granting new MCP servers
  if (patch.mcpServerIds) {
    for (const serverId of patch.mcpServerIds) {
      if (!callerMcpServers.has(serverId)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Strip sensitive fields from agent record before returning to agent tools.
 * Preserve presence flags for UI/tool decision-making.
 */
function sanitizeAgentForTool(agent: any) {
  const rc = agent.runtimeConfig || {};
  const sanitized = { ...agent };

  // Strip sensitive credentials but preserve boolean flags
  if (sanitized.runtimeConfig) {
    const runtimeConfig = { ...rc };
    if (runtimeConfig.tavilyApiKey) {
      runtimeConfig.tavilyApiKeyPresent = true;
      delete runtimeConfig.tavilyApiKey;
    }
    if (runtimeConfig.searxngApiKey) {
      runtimeConfig.searxngApiKeyPresent = true;
      delete runtimeConfig.searxngApiKey;
    }
    if (runtimeConfig.mcpCredentials) {
      const credKeys = Object.keys(runtimeConfig.mcpCredentials);
      runtimeConfig.mcpCredentialsPresent = credKeys.length > 0 ? credKeys : undefined;
      delete runtimeConfig.mcpCredentials;
    }
    sanitized.runtimeConfig = runtimeConfig;
  }

  return sanitized;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ companyId: string; agentId: string }> }
) {
  const { companyId, agentId } = await params;

  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return unauthorized();

  const runCtx = validateRunToken(token);
  if (!runCtx) return unauthorized();
  if (runCtx.companyId !== companyId) return forbidden();

  const agent = await db.query.agents.findFirst({
    where: and(eq(agents.id, agentId), eq(agents.companyId, companyId)),
  });

  if (!agent) return notFound();

  return NextResponse.json(sanitizeAgentForTool(agent));
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ companyId: string; agentId: string }> }
) {
  const { companyId, agentId } = await params;

  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return unauthorized();

  const runCtx = validateRunToken(token);
  if (!runCtx) return unauthorized();
  if (runCtx.companyId !== companyId) return forbidden();

  // Verify target agent exists and belongs to same company
  const targetAgent = await db.query.agents.findFirst({
    where: and(eq(agents.id, agentId), eq(agents.companyId, companyId)),
  });

  if (!targetAgent) return notFound();

  const body = await req.json();

  try {
    let updated = targetAgent;

    // Handle status mutation (active/paused/archived)
    if (body.status) {
      const status = body.status as AgentStatus;

      // Safety: forbid self-pause/archive
      if (runCtx.agentId === agentId && (status === 'paused' || status === 'archived')) {
        return NextResponse.json(
          { error: 'self_pause_forbidden', message: 'Cannot pause or archive yourself. Use the Board UI or create an approval request.' },
          { status: 400 }
        );
      }

      updated = await setAgentStatus(agentId, status);
    }

    // Handle heartbeat config
    if (body.heartbeat !== undefined) {
      const heartbeatPatch = body.heartbeat;

      // Validate schedule if provided
      if (heartbeatPatch.cronExpression || heartbeatPatch.intervalSec) {
        const normalized = normalizeHeartbeatConfig(heartbeatPatch);
        const validationError = validateHeartbeatSchedule(normalized);
        if (validationError) {
          return badRequest(`Invalid heartbeat configuration: ${validationError}`);
        }
      }

      updated = await updateAgentRuntimeConfig(agentId, { heartbeat: heartbeatPatch });
    }

    // Handle profile updates
    if (body.profile) {
      const { name, title, urlKey, reportsToId, instructionsBundleSoulMd, instructionsBundleAgentsMd } =
        body.profile;

      // Must-fix #1: Partial profile PATCH — load existing agent and merge required fields
      if (name !== undefined || title !== undefined || urlKey !== undefined || reportsToId !== undefined) {
        updated = await updateAgentProfile(agentId, {
          name: name ?? updated.name,
          title: title ?? updated.title,
          urlKey: urlKey ?? updated.urlKey,
          reportsToId: reportsToId !== undefined ? reportsToId : updated.reportsToId,
        });
      }

      // Must-fix #2: Instructions field mapping — lib expects soulMd/agentsMd, not full field names
      if (instructionsBundleSoulMd !== undefined || instructionsBundleAgentsMd !== undefined) {
        updated = await updateAgentInstructions(agentId, {
          ...(instructionsBundleSoulMd !== undefined && { soulMd: instructionsBundleSoulMd }),
          ...(instructionsBundleAgentsMd !== undefined && { agentsMd: instructionsBundleAgentsMd }),
        });
      }
    }

    // Handle model change
    if (body.model) {
      const { modelId, providerId } = body.model;
      if (!modelId) {
        return badRequest('Model ID is required.');
      }
      updated = await updateAgentModel(agentId, { modelId, providerId });
    }

    // Handle capabilities (skills/toolsets/tools/mcp/codeExecution)
    if (body.capabilities) {
      const {
        assignedSkills,
        assignedToolsets,
        assignedTools,
        mcpServerIds,
        mcpToolPolicy,
        integrations,
        clearIntegrations,
        knowledgeGraph,
        reason,
      } = body.capabilities;

      // Must-fix #3: Enforce non-empty reason when granting privileged capabilities
      const isPrivilegeGrant = await checkPrivilegeGrant(
        runCtx.agentId,
        runCtx.companyId,
        { assignedToolsets, mcpServerIds }
      );

      if (isPrivilegeGrant && (!reason || reason.trim().length === 0)) {
        return badRequest(
          'Granting privileged capabilities (code-execution, MCP servers, or toolsets the caller does not hold) requires a non-empty reason field for audit.'
        );
      }

      updated = await updateAgentCapabilities(agentId, {
        toolsets: assignedToolsets ?? updated.assignedToolsets ?? [],
        assignedTools: assignedTools ?? (updated.runtimeConfig as any)?.assignedTools ?? [],
        assignedSkills: assignedSkills ?? updated.assignedSkills ?? [],
        ...(mcpServerIds && { mcpServerIds }),
        ...(mcpToolPolicy && { mcpToolPolicy }),
        ...(integrations && { integrations }),
        ...(clearIntegrations && { clearIntegrations }),
        ...(knowledgeGraph && { knowledgeGraph }),
      });
    }

    // Handle observational memory (P2)
    if (body.observationalMemory) {
      const omInput: UpdateAgentObservationalMemoryInput = body.observationalMemory;
      updated = await updateAgentObservationalMemory(agentId, omInput);
    }

    return NextResponse.json(sanitizeAgentForTool(updated));
  } catch (err) {
    if (err instanceof AgentValidationError) {
      return badRequest(err.message);
    }
    console.error('Agent PATCH error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
