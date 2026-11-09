import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { db, agents } from '@tourbillon/db';
import { and, eq } from 'drizzle-orm';
import { requireBoardCompany } from '@/lib/board-route-auth';
import {
  OAUTH_NOT_CONFIGURED_ERROR,
  USER_SCOPE_UNSUPPORTED_MESSAGE,
  buildOAuthState,
  isOAuthStateSecretConfigured,
  logOAuthStateSecretMissing,
  oauthNonceCookieName,
  oauthNonceCookieOptions,
  settingsRedirect,
} from '@/lib/vault-oauth-state';
import { recordOAuthNonce } from '@/lib/vault-oauth-nonce-store';

const authorizeSchema = z.object({
  serverId: z.string().min(1),
  scope: z.enum(['company', 'company_user', 'agent']),
  userId: z.string().optional(),
  agentId: z.string().optional(),
});

export async function GET(req: NextRequest) {
  // #106: board only (starts an OAuth grant that stores credentials for the active company).
  const auth = await requireBoardCompany(req);
  if (!auth.ok) return auth.response;

  // #112: fail closed. Without a real BETTER_AUTH_SECRET the state HMAC is forgeable.
  if (!isOAuthStateSecretConfigured()) {
    logOAuthStateSecretMissing('start');
    return settingsRedirect(`/settings?oauth_error=${OAUTH_NOT_CONFIGURED_ERROR}`);
  }

  try {
    const { searchParams } = new URL(req.url);

    const params = {
      serverId: searchParams.get('serverId'),
      scope: searchParams.get('scope'),
      userId: searchParams.get('userId') || undefined,
      agentId: searchParams.get('agentId') || undefined,
    };

    const validated = authorizeSchema.parse(params);

    // #112: board sessions carry no user identity; refuse NEW company_user OAuth clearly.
    if (validated.scope === 'company_user' || validated.userId) {
      return NextResponse.json({ error: USER_SCOPE_UNSUPPORTED_MESSAGE }, { status: 400 });
    }
    if ((validated.scope === 'agent') !== Boolean(validated.agentId)) {
      return NextResponse.json(
        { error: 'agentId is required for agent-scoped grants and not allowed otherwise' },
        { status: 400 },
      );
    }

    // Agent-scoped grants: must be in the board company and not archived (404 same as unknown).
    if (validated.agentId) {
      const agent = await db.query.agents.findFirst({
        where: and(eq(agents.id, validated.agentId), eq(agents.companyId, auth.value.id)),
      });
      if (!agent || agent.status === 'archived') {
        return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
      }
    }

    if (validated.serverId === 'github-mcp') {
      const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;

      if (!clientId) {
        return NextResponse.json({ error: 'GitHub OAuth not configured' }, { status: 500 });
      }

      const baseUrl = process.env.BETTER_AUTH_URL || 'http://localhost:3002';
      const redirectUri = `${baseUrl}/api/vault/oauth/callback`;

      const built = buildOAuthState({
        serverId: validated.serverId,
        scope: validated.scope,
        agentId: validated.agentId,
        companyId: auth.value.id,
      });
      if (!built) {
        logOAuthStateSecretMissing('start');
        return settingsRedirect(`/settings?oauth_error=${OAUTH_NOT_CONFIGURED_ERROR}`);
      }
      await recordOAuthNonce(built.nonce, built.expiresAt);

      const githubAuthUrl = new URL('https://github.com/login/oauth/authorize');
      githubAuthUrl.searchParams.set('client_id', clientId);
      githubAuthUrl.searchParams.set('redirect_uri', redirectUri);
      githubAuthUrl.searchParams.set('scope', 'repo,user');
      githubAuthUrl.searchParams.set('state', built.state);

      const res = NextResponse.redirect(githubAuthUrl.toString());
      res.cookies.set(
        oauthNonceCookieName(auth.value.id),
        built.nonce,
        oauthNonceCookieOptions(req.headers),
      );
      return res;
    }

    return NextResponse.json({ error: 'Unsupported OAuth provider' }, { status: 400 });
  } catch (error) {
    console.error('Error in OAuth authorize:', error);

    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Invalid query parameters', details: error.issues },
        { status: 400 },
      );
    }

    return NextResponse.json({ error: 'Failed to initiate OAuth flow' }, { status: 500 });
  }
}
