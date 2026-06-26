import { NextRequest, NextResponse } from 'next/server';
import {
  createLlmProvider,
  LlmProviderValidationError,
  listLlmProvidersPublic,
} from '@/lib/llm-providers';

export async function GET() {
  try {
    const providers = await listLlmProvidersPublic();
    return NextResponse.json({ providers });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to list providers';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      name?: string;
      type?: string;
      baseURL?: string;
      apiKey?: string | null;
      headers?: Record<string, string>;
      apiMode?: string;
      isDefault?: boolean;
    };

    const provider = await createLlmProvider({
      name: body.name ?? '',
      type: body.type ?? '',
      baseURL: body.baseURL ?? '',
      apiKey: body.apiKey,
      headers: body.headers,
      apiMode: body.apiMode,
      isDefault: body.isDefault,
    });

    return NextResponse.json({ provider }, { status: 201 });
  } catch (err) {
    if (err instanceof LlmProviderValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    const message = err instanceof Error ? err.message : 'Failed to create provider';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
