import { NextRequest, NextResponse } from 'next/server';
import {
  deleteLlmProvider,
  getLlmProviderPublic,
  LlmProviderValidationError,
  updateLlmProvider,
} from '@/lib/llm-providers';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
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
    };

    const provider = await updateLlmProvider(id, body);
    return NextResponse.json({ provider });
  } catch (err) {
    if (err instanceof LlmProviderValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    const message = err instanceof Error ? err.message : 'Failed to update provider';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    await deleteLlmProvider(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof LlmProviderValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    const message = err instanceof Error ? err.message : 'Failed to delete provider';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
