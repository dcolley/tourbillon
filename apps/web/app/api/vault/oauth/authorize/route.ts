import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { db, agents } from '@tourbillon/db';
import { and, eq } from 'drizzle-orm';
import { requireBoardCompany } from '@/lib/board-route-auth';
import {
  OAUTH_NOT_CONFIGURED_ERROR,
  isOAuthStateSecretConfigured,
  logOAuthStateSecretMissing,
  signOAuthState,
} from '@/lib/vault-oauth-state';

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
    return NextResponse.redirect(new URL(`/settings?oauth_error=${OAUTH_NOT_CONFIGURED_ERROR}`, req.nextUrl.origin));
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

    // Agent-scoped grants must target an agent in the board's company (other company → 404).
    if (validated.agentId) {
      const agent = await db.query.agents.findFirst({
        where: and(eq(agents.id, validated.agentId), eq(agents.companyId, auth.value.id)),
      });
      if (!agent) return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }
    
    if (validated.serverId === 'github-mcp') {
      const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
      
      if (!clientId) {
        return NextResponse.json(
          { error: 'GitHub OAuth not configured' },
          { status: 500 }
        );
      }
      
      const baseUrl = process.env.BETTER_AUTH_URL || 'http://localhost:3002';
      const redirectUri = `${baseUrl}/api/vault/oauth/callback`;
      
      const statePayload = JSON.stringify({
        serverId: validated.serverId,
        scope: validated.scope,
        userId: validated.userId,
        agentId: validated.agentId,
      });
      const signature = signOAuthState(statePayload);
      if (!signature) {
        logOAuthStateSecretMissing('start');
        return NextResponse.redirect(new URL(`/settings?oauth_error=${OAUTH_NOT_CONFIGURED_ERROR}`, req.nextUrl.origin));
      }
      const state = Buffer.from(JSON.stringify({
        payload: statePayload,
        signature,
      })).toString('base64');
      
      const githubAuthUrl = new URL('https://github.com/login/oauth/authorize');
      githubAuthUrl.searchParams.set('client_id', clientId);
      githubAuthUrl.searchParams.set('redirect_uri', redirectUri);
      githubAuthUrl.searchParams.set('scope', 'repo,user');
      githubAuthUrl.searchParams.set('state', state);
      
      return NextResponse.redirect(githubAuthUrl.toString());
    }
    
    return NextResponse.json(
      { error: 'Unsupported OAuth provider' },
      { status: 400 }
    );
  } catch (error) {
    console.error('Error in OAuth authorize:', error);
    
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Invalid query parameters', details: error.issues },
        { status: 400 }
      );
    }
    
    return NextResponse.json(
      { error: 'Failed to initiate OAuth flow' },
      { status: 500 }
    );
  }
}
