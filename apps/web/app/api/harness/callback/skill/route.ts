/**
 * #281 — GET /api/harness/callback/skill
 * Serves the skill-install markdown (Hermes SKILL.md shape) that teaches the harness the
 * heartbeat + callback protocol. Auth-gated (run session token); contains no secrets.
 */
import { NextRequest, NextResponse } from 'next/server';
import { handleHarnessSkill } from '../../../../../lib/harness/callback-gate';
import { buildHarnessCallbackDeps } from '../../../../../lib/harness/callback-deps';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const result = await handleHarnessSkill({
    authorization: req.headers.get('authorization'),
    deps: buildHarnessCallbackDeps(),
  });
  if (result.status === 200 && typeof result.body === 'string') {
    return new NextResponse(result.body, {
      status: 200,
      headers: { 'Content-Type': result.contentType ?? 'text/markdown; charset=utf-8' },
    });
  }
  return NextResponse.json(result.body, { status: result.status });
}
