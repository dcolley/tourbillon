import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  updateAgentSecrets,
  deleteAgentSecrets,
  getAgentByUrlKey,
  AgentValidationError,
  type UpdateAgentSecretsInput,
} from '@/lib/agents';
import { validateRunToken } from '@/lib/auth/run-token';
import { verifyMobileToken } from '@/lib/mobile-auth';
import { getActiveCompanyOrNull } from '@/lib/company';
import type { Agent, Company } from '@tourbillon/db';

import type { AgentRuntimeConfig } from '@tourbillon/shared';

const UpdateSecretsSchema = z.object({
  secrets: z.record(z.string(), z.string()),
  replace: z.boolean().optional(),
});

const DeleteSecretsSchema = z.object({
  keys: z.array(z.string()),
});

/**
 * #103: Board-only access, scoped to the caller's company.
 * - Agent run/chat tokens are rejected outright (403): agents must never write
 *   (their own or a peer's) secrets through this route.
 * - Board auth reuses the existing board pattern (see /api/jobs/heartbeat/list,
 *   /api/companies/[companyId]/search): mobile X-Company-Token, else the
 *   active-company board cookie. Neither present → 401.
 * - The agent is looked up inside that company only, so another company's
 *   agent is indistinguishable from a missing one (404).
 */
async function resolveBoardAgent(
  req: NextRequest,
  agentUrlKey: string,
): Promise<{ agent: Agent; company: Company } | { error: NextResponse }> {
  const bearer = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim();
  if (bearer && validateRunToken(bearer)) {
    return {
      error: NextResponse.json({ error: 'Agent tokens cannot manage agent secrets' }, { status: 403 }),
    };
  }

  const company = await getActiveCompanyOrNull(await verifyMobileToken(req));
  if (!company) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }

  const agent = await getAgentByUrlKey(agentUrlKey, company.id);
  if (!agent) {
    return { error: NextResponse.json({ error: 'Agent not found' }, { status: 404 }) };
  }
  return { agent, company };
}

/** #103: write-only — responses carry secret key names only, never any runtimeConfig values. */
function secretKeysResponse(agent: Agent) {
  const keys = Object.keys((agent.runtimeConfig as AgentRuntimeConfig | null)?.secrets ?? {});
  return { keys, count: keys.length };
}

/**
 * AC-B1.3: Set or rotate agent secrets/environment variables.
 * PUT /api/agents/:agentId/secrets
 */
export async function PUT(
  req: NextRequest,
  context: { params: Promise<{ agentId: string }> }
): Promise<NextResponse> {
  try {
    const { agentId } = await context.params;

    const resolved = await resolveBoardAgent(req, agentId);
    if ('error' in resolved) return resolved.error;
    const { agent } = resolved;

    const body = await req.json();
    const parsed = UpdateSecretsSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: parsed.error.issues },
        { status: 400 }
      );
    }

    const input: UpdateAgentSecretsInput = {
      secrets: parsed.data.secrets,
      replace: parsed.data.replace ?? false,
    };

    const updated = await updateAgentSecrets(agent.id, input);

    // AC-B1.1 / #103: write-only. Previously this echoed the whole agent row, whose
    // runtimeConfig still carried mcpCredentials / tavilyApiKey / searxngApiKey values.
    return NextResponse.json({
      success: true,
      ...secretKeysResponse(updated),
      message: 'Secrets updated successfully. Changes will take effect on next agent wake.',
    });
  } catch (error) {
    if (error instanceof AgentValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error('Error updating agent secrets:', error);
    return NextResponse.json(
      { error: 'Failed to update secrets' },
      { status: 500 }
    );
  }
}

/**
 * AC-B1.3: Delete specific secret keys from an agent.
 * DELETE /api/agents/:agentId/secrets
 */
export async function DELETE(
  req: NextRequest,
  context: { params: Promise<{ agentId: string }> }
): Promise<NextResponse> {
  try {
    const { agentId } = await context.params;

    const resolved = await resolveBoardAgent(req, agentId);
    if ('error' in resolved) return resolved.error;
    const { agent } = resolved;

    const body = await req.json();
    const parsed = DeleteSecretsSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: parsed.error.issues },
        { status: 400 }
      );
    }

    const updated = await deleteAgentSecrets(agent.id, parsed.data.keys);

    // AC-B1.1 / #103: write-only (see PUT).
    return NextResponse.json({
      success: true,
      ...secretKeysResponse(updated),
      message: 'Secrets deleted successfully.',
    });
  } catch (error) {
    if (error instanceof AgentValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error('Error deleting agent secrets:', error);
    return NextResponse.json(
      { error: 'Failed to delete secrets' },
      { status: 500 }
    );
  }
}

/**
 * AC-B1.1: Get list of secret keys (values are never returned).
 * GET /api/agents/:agentId/secrets
 */
export async function GET(
  req: NextRequest,
  context: { params: Promise<{ agentId: string }> }
): Promise<NextResponse> {
  try {
    const { agentId } = await context.params;

    const resolved = await resolveBoardAgent(req, agentId);
    if ('error' in resolved) return resolved.error;
    const { agent } = resolved;

    // AC-B1.1: Return only keys, never values (write-only)
    return NextResponse.json(secretKeysResponse(agent));
  } catch (error) {
    console.error('Error fetching agent secret keys:', error);
    return NextResponse.json(
      { error: 'Failed to fetch secret keys' },
      { status: 500 }
    );
  }
}
