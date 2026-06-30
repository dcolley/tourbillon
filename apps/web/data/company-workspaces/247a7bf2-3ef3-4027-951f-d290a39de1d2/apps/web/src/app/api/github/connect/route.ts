// ============================================================================
// TOUR-116: GitHub Integration — OAuth Connect Endpoint
// ============================================================================
// Initiates the GitHub App / OAuth flow for connecting a GitHub account.

import { NextResponse } from 'next/server';

/**
 * GET /api/github/connect — Redirect to GitHub OAuth authorization URL.
 * 
 * This endpoint starts the GitHub App Installation flow by redirecting the user
 * to GitHub's OAuth consent screen. After authorization, the user is redirected
 * back to /api/github/callback with an authorization code.
 */
export async function GET(request: Request) {
  try {
    const clientId = process.env.GITHUB_CLIENT_ID;
    const redirectUri = process.env.GITHUB_REDIRECT_URI || `${process.env.NEXT_PUBLIC_BASE_URL}/api/github/callback`;

    if (!clientId) {
      return NextResponse.json(
        { error: 'GitHub OAuth not configured. Set GITHUB_CLIENT_ID and GITHUB_REDIRECT_URI in environment.' },
        { status: 503 }
      );
    }

    // Build the GitHub OAuth authorization URL with required scopes
    const state = generateState(); // CSRF protection
    
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      state,
      scope: 'repo user admin:org', // Read/write access to repos and org info
      login: '', // Optional: pre-fill GitHub username suggestion
    });

    const authUrl = `https://github.com/login/oauth/authorize?${params.toString()}`;

    // Set the state in a cookie for verification on callback
    const response = NextResponse.redirect(authUrl);
    response.cookies.set('github_oauth_state', state, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 10, // 10 minutes
      path: '/',
    });

    return response;
  } catch (error: any) {
    console.error('[GITHUB-CONNECT] Error initiating OAuth:', error.message);
    return NextResponse.json(
      { error: 'Failed to initiate GitHub connection' },
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
