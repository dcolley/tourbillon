import { NextRequest, NextResponse } from 'next/server';
import {
  deleteLlmProvider,
  getLlmProviderPublic,
  LlmProviderValidationError,
  llmProviderErrorBody,
  updateLlmProvider,
} from '@/lib/llm-providers';
import { requireBoardIdentity } from '@/lib/board-route-auth';

// #106: board only (provider config is instance-global).
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireBoardIdentity(req);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  try {
    const provider = await getLlmProviderPublic(id);
    if (!provider) {
      return NextResponse.json({ error: 'Provider not found' }, { status: 404 });
    }
    return NextResponse.json({ provider });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load provider';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireBoardIdentity(req);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  try {
    const body = (await req.json()) as {
      name?: string;
      type?: string;
      baseURL?: string;
      apiKey?: string | null;
      headers?: Record<string, string>;
      apiMode?: string;
      isDefault?: boolean;
      clearApiKey?: boolean;
      defaultModelSettings?: Record<string, unknown>;
      defaultModel?: string | null;
      stickiness?: string;
      stickinessHeaderName?: string;
    };

    const provider = await updateLlmProvider(id, body);
    return NextResponse.json({ provider });
  } catch (err) {
    if (err instanceof LlmProviderValidationError) {
      const { body, status } = llmProviderErrorBody(err);
      return NextResponse.json(body, { status });
    }
    const message = err instanceof Error ? err.message : 'Failed to update provider';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireBoardIdentity(req);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  try {
    await deleteLlmProvider(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof LlmProviderValidationError) {
      const { body, status } = llmProviderErrorBody(err);
      return NextResponse.json(body, { status });
    }
    const message = err instanceof Error ? err.message : 'Failed to delete provider';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
