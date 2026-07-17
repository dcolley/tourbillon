import { NextRequest, NextResponse } from 'next/server';
import { runTavilySearch } from '@/lib/tavily/client';
import { authorizeTavilyRequest, tavilyErrorResponse } from '@/lib/tavily/route-auth';
import { tavilySearchSchema } from '@/lib/tavily/schemas';

export async function POST(req: NextRequest) {
  const auth = await authorizeTavilyRequest(req);
  if (auth instanceof NextResponse) return auth;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = tavilySearchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const result = await runTavilySearch({
      apiKey: auth.apiKey,
      query: parsed.data.query,
      maxResults: parsed.data.maxResults,
      searchDepth: parsed.data.searchDepth,
      includeAnswer: parsed.data.includeAnswer,
    });
    return NextResponse.json(result);
  } catch (err) {
    return tavilyErrorResponse(err);
  }
}
