// ============================================================================
// TOUR-97: Slack Integration — OAuth Connect Endpoint
// ============================================================================
// Initiates the Slack App Installation / OAuth flow.

import { NextResponse } from 'next/server';
import { SLACK_OAUTH_SCOPES, SLACK_APP_MANIFEST } from '@/lib/slack/constants';

/**
 * GET /api/slack/connect — Redirect to Slack OAuth authorization URL.
 * 
 * This endpoint starts the Slack App Installation flow by redirecting the user
 * to Slack's OAuth consent screen. After authorization, the user is redirected
 * back to /api/slack/callback with an authorization code.
 */
export async function GET(request: Request) {
  try {
    const clientId = process.env.SLACK_CLIENT_ID;
    const redirectUri = process.env.SLACK_REDIRECT_URI || `${process.env.NEXT_PUBLIC_BASE_URL}/api/slack/callback`;

    if (!clientId) {
      return NextResponse.json(
        { error: 'Slack OAuth not configured. Set SLACK_CLIENT_ID and SLACK_REDIRECT_URI in environment.' },
        { status: 503 }
      );
    }

    // Build the Slack OAuth authorization URL with required scopes
    const state = generateState(); // CSRF protection
    
    const params = new URLSearchParams({
      client_id: clientId,
      scope: SLACK_OAUTH_SCOPES.join(','),
      redirect_uri: redirectUri,
      state,
      install_to_team: 'true', // Install to workspace (not DM)
    });

    const authUrl = `https://slack.com/oauth/v2/authorize?${params.toString()}`;

    // Set the state in a cookie for verification on callback
    const response = NextResponse.redirect(authUrl);
    response.cookies.set('slack_oauth_state', state, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 10, // 10 minutes
      path: '/',
    });

    return response;
  } catch (error: any) {
    console.error('[SLACK-CONNECT] Error initiating OAuth:', error.message);
    return NextResponse.json(
      { error: 'Failed to initiate Slack connection' },
      { status: 500 }
    );
  }
}

/**
 * Generate a cryptographically secure state parameter for CSRF protection.
 */
function generateState(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * GET /api/slack/manifest — Return the Slack App Manifest for easy installation.
 * 
 * This endpoint provides the app manifest JSON that can be used to install
 * the Tourbillon Bot via the Slack API or developer portal.
 */
export async function MANIFEST() {
  // For now, return a redirect to the Slack App Management page
  const response = NextResponse.json({ message: 'App Manifest endpoint' });
  return response;
}
