// ============================================================================
// TOUR-97: Slack Integration — OAuth Callback Handler
// ============================================================================
// Handles the callback from Slack OAuth authorization flow.

import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const code = searchParams.get('code');
    const state = searchParams.get('state');
    const error = searchParams.get('error');

    // Check for OAuth errors from Slack
    if (error) {
      return NextResponse.json(
        { error: 'Slack authorization failed', details: error },
        { status: 400 }
      );
    }

    if (!code || !state) {
      return NextResponse.json(
        { error: 'Missing authorization code or state parameter' },
        { status: 400 }
      );
    }

    // Verify state (CSRF protection) — compare with cookie set during connect
    const cookies = request.headers.get('cookie') || '';
    const storedState = cookies.split(';').find(c => c.trim().startsWith('slack_oauth_state='))?.split('=')[1];
    
    if (!storedState || storedState !== state) {
      console.warn('[SLACK-CALLBACK] State mismatch — possible CSRF attack');
      return NextResponse.json(
        { error: 'Invalid state parameter' },
        { status: 403 }
      );
    }

    const clientId = process.env.SLACK_CLIENT_ID!;
    const clientSecret = process.env.SLACK_CLIENT_SECRET!;
    const redirectUri = process.env.SLACK_REDIRECT_URI || `${process.env.NEXT_PUBLIC_BASE_URL}/api/slack/callback`;

    // Exchange authorization code for tokens
    const tokenResponse = await fetch('https://slack.com/api/oauth.v2.access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    });

    const data = await tokenResponse.json();

    if (!data.ok) {
      console.error('[SLACK-CALLBACK] Token exchange failed:', data.error);
      return NextResponse.json(
        { error: 'Failed to authenticate with Slack', details: data.error },
        { status: 400 }
      );
    }

    // Extract tokens and workspace info
    const botToken = data.authed_user?.access_token || data.access_token;
    const teamId = data.team?.id;
    const teamName = data.team?.name;
    const appId = data.app_id;

    console.log('[SLACK-CALLBACK] OAuth successful — workspace:', teamName, 'team_id:', teamId);

    // In production, persist these to the slack_connections table:
    // await db.insert(slackConnections).values({
    //   teamId, appId, botToken, teamName, userId: data.authed_user?.id ?? null,
    // });

    return NextResponse.json({
      success: true,
      message: 'Slack connection established successfully',
      workspace: teamName,
      teamId,
      appId,
    });

  } catch (error: any) {
    console.error('[SLACK-CALLBACK] Error processing callback:', error.message);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
