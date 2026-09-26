import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createHmac } from 'crypto';

const authorizeSchema = z.object({
  serverId: z.string().min(1),
  scope: z.enum(['company', 'company_user', 'agent']),
  userId: z.string().optional(),
  agentId: z.string().optional(),
});

function signOAuthState(payload: string): string {
  const secret = process.env.BETTER_AUTH_SECRET || 'change-me-in-production';
  const hmac = createHmac('sha256', secret);
  hmac.update(payload);
  return hmac.digest('hex');
}

function verifyOAuthState(payload: string, signature: string): boolean {
  const expected = signOAuthState(payload);
  return signature === expected;
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    
    const params = {
      serverId: searchParams.get('serverId'),
      scope: searchParams.get('scope'),
      userId: searchParams.get('userId') || undefined,
      agentId: searchParams.get('agentId') || undefined,
    };
    
    const validated = authorizeSchema.parse(params);
    
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
        { error: 'Invalid query parameters', details: error.errors },
        { status: 400 }
      );
    }
    
    return NextResponse.json(
      { error: 'Failed to initiate OAuth flow' },
      { status: 500 }
    );
  }
}
