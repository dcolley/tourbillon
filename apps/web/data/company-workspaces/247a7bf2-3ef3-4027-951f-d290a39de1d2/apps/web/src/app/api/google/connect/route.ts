// ============================================================================
// TOUR-116: Google Integration — OAuth Connect Endpoint
// ============================================================================
// Initiates the Google OAuth flow for connecting a Google account.

import { NextResponse } from 'next/server';

/**
 * GET /api/google/connect — Redirect to Google OAuth authorization URL.
 * 
 * This endpoint starts the Google OAuth flow by redirecting the user
 * to Google's consent screen. After authorization, the user is redirected
 * back to /api/google/callback with an authorization code.
 */
export async function GET(request: Request) {
  try {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const redirectUri = process.env.GOOGLE_REDIRECT_URI || `${process.env.NEXT_PUBLIC_BASE_URL}/api/google/callback`;

    if (!clientId) {
      return NextResponse.json(
        { error: 'Google OAuth not configured. Set GOOGLE_CLIENT_ID and GOOGLE_REDIRECT_URI in environment.' },
        { status: 503 }
      );
    }

    // Build the Google OAuth authorization URL with required scopes
    const state = generateState(); // CSRF protection
    
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile',
      state,
      access_type: 'offline', // For refresh token
      prompt: 'consent', // Force consent screen to get refresh token
    });

    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;

    // Set the state in a cookie for verification on callback
    const response = NextResponse.redirect(authUrl);
    response.cookies.set('google_oauth_state', state, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 10, // 10 minutes
      path: '/',
    });

    return response;
  } catch (error: any) {
    console.error('[GOOGLE-CONNECT] Error initiating OAuth:', error.message);
    return NextResponse.json(
      { error: 'Failed to initiate Google connection' },
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
