import { NextRequest, NextResponse } from 'next/server';
import { runSearxngSearch } from '@/lib/searxng/client';
import { authorizeSearxngRequest, searxngErrorResponse } from '@/lib/searxng/route-auth';
import { searxngNewsSearchSchema } from '@/lib/searxng/schemas';

export async function POST(req: NextRequest) {
  const auth = await authorizeSearxngRequest(req);
  if (auth instanceof NextResponse) return auth;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = searxngNewsSearchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const result = await runSearxngSearch({
      baseUrl: auth.baseUrl,
      apiKey: auth.apiKey,
      query: parsed.data.query,
      maxResults: parsed.data.maxResults,
      categories: 'news',
      language: parsed.data.language,
      timeRange: parsed.data.timeRange,
    });
    return NextResponse.json(result);
  } catch (err) {
    return searxngErrorResponse(err);
  }
}
