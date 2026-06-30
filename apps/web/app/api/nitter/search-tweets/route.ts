import { NextRequest, NextResponse } from 'next/server';
import { NitterClient } from '@/lib/nitter/client';
import { authorizeNitterRequest, nitterErrorResponse } from '@/lib/nitter/route-auth';
import { searchTweetsSchema } from '@/lib/nitter/schemas';

export async function POST(req: NextRequest) {
  const auth = await authorizeNitterRequest(req);
  if (auth instanceof NextResponse) return auth;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = searchTweetsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const client = new NitterClient();
    const result = await client.searchTweets(parsed.data);
    return NextResponse.json(result);
  } catch (err) {
    return nitterErrorResponse(err);
  }
}
