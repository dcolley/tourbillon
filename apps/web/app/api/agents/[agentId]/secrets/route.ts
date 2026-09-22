import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  updateAgentSecrets,
  deleteAgentSecrets,
  getAgentByUrlKey,
  AgentValidationError,
  type UpdateAgentSecretsInput,
} from '@/lib/agents';

import type { AgentRuntimeConfig } from '@tourbillon/shared';

const UpdateSecretsSchema = z.object({
  secrets: z.record(z.string(), z.string()),
  replace: z.boolean().optional(),
});

const DeleteSecretsSchema = z.object({
  keys: z.array(z.string()),
});

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

    const agent = await getAgentByUrlKey(agentId);
    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

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

    // AC-B1.1: Never return secret values after save (write-only)
    const runtimeConfig = updated.runtimeConfig as AgentRuntimeConfig | null;
    const secrets = runtimeConfig?.secrets;
    const safeRuntimeConfig: Record<string, unknown> = {
      ...(updated.runtimeConfig as Record<string, unknown>),
      secrets: secrets ? Object.keys(secrets) : undefined,
    };

    return NextResponse.json({
      success: true,
      agent: {
        ...updated,
        runtimeConfig: safeRuntimeConfig,
      },
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

    const agent = await getAgentByUrlKey(agentId);
    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    const body = await req.json();
    const parsed = DeleteSecretsSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: parsed.error.issues },
        { status: 400 }
      );
    }

    const updated = await deleteAgentSecrets(agent.id, parsed.data.keys);

    // AC-B1.1: Never return secret values (write-only)
    const runtimeConfig = updated.runtimeConfig as AgentRuntimeConfig | null;
    const secrets = runtimeConfig?.secrets;
    const safeRuntimeConfig: Record<string, unknown> = {
      ...(updated.runtimeConfig as Record<string, unknown>),
      secrets: secrets ? Object.keys(secrets) : undefined,
    };

    return NextResponse.json({
      success: true,
      agent: {
        ...updated,
        runtimeConfig: safeRuntimeConfig,
      },
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

    const agent = await getAgentByUrlKey(agentId);
    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    const runtimeConfig = agent.runtimeConfig as { secrets?: Record<string, string> } | null;
    const secrets = runtimeConfig?.secrets ?? {};

    // AC-B1.1: Return only keys, never values (write-only)
    return NextResponse.json({
      keys: Object.keys(secrets),
      count: Object.keys(secrets).length,
    });
  } catch (error) {
    console.error('Error fetching agent secret keys:', error);
    return NextResponse.json(
      { error: 'Failed to fetch secret keys' },
      { status: 500 }
    );
  }
}
