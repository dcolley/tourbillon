import { NextRequest, NextResponse } from 'next/server';
import {
  createLlmProvider,
  LlmProviderValidationError,
  llmProviderErrorBody,
  listLlmProvidersPublic,
} from '@/lib/llm-providers';
import { requireBoardIdentity } from '@/lib/board-route-auth';

// #106: provider config is instance-global and steers all agent LLM traffic: board only.
export async function GET(req: NextRequest) {
  const auth = await requireBoardIdentity(req);
  if (!auth.ok) return auth.response;
  try {
    const providers = await listLlmProvidersPublic();
    return NextResponse.json({ providers });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to list providers';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireBoardIdentity(req);
  if (!auth.ok) return auth.response;
  try {
    const body = (await req.json()) as {
      name?: string;
      type?: string;
      baseURL?: string;
      apiKey?: string | null;
      headers?: Record<string, string>;
      apiMode?: string;
      isDefault?: boolean;
      defaultModelSettings?: Record<string, unknown>;
      defaultModel?: string | null;
      stickiness?: string;
      stickinessHeaderName?: string;
    };

    const provider = await createLlmProvider({
      name: body.name ?? '',
      type: body.type ?? '',
      baseURL: body.baseURL ?? '',
      apiKey: body.apiKey,
      headers: body.headers,
      apiMode: body.apiMode,
      isDefault: body.isDefault,
      defaultModelSettings: body.defaultModelSettings,
      defaultModel: body.defaultModel,
      stickiness: body.stickiness,
      stickinessHeaderName: body.stickinessHeaderName,
    });

    return NextResponse.json({ provider }, { status: 201 });
  } catch (err) {
    if (err instanceof LlmProviderValidationError) {
      const { body, status } = llmProviderErrorBody(err);
      return NextResponse.json(body, { status });
    }
    const message = err instanceof Error ? err.message : 'Failed to create provider';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
