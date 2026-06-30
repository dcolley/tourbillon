import { NextRequest, NextResponse } from 'next/server';

/**
 * Auth0 Login Route - Initiates OIDC Authorization Code Flow
 * 
 * Redirects the user to Auth0 Universal Login Page for authentication.
 * Uses PKCE (Proof Key for Code Exchange) flow for security without requiring a client_secret.
 */

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const callbackUrl = searchParams.get('callbackUrl');
    
    // Required environment variables
    const auth0Domain = process.env.AUTH0_DOMAIN;
    const clientId = process.env.AUTH0_CLIENT_ID;
    const audience = process.env.AUTH0_AUDIENCE;
    
    if (!auth0Domain || !clientId) {
      console.error('Auth0 configuration missing: AUTH0_DOMAIN and AUTH0_CLIENT_ID are required');
      return NextResponse.redirect(
        `${process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'}/auth/signup?error=auth_config_missing`
      );
    }

    // Generate PKCE code verifier and challenge
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await generateCodeChallenge(codeVerifier);
    
    // Store code verifier in a secure cookie for later exchange
    const response = NextResponse.redirect('');
    response.cookies.set('auth0_code_verifier', codeVerifier, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 60 * 10, // 10 minutes expiry for PKCE exchange
      path: '/api/auth/auth0/callback',
    });

    // Build Auth0 authorization URL with PKCE
    const authParams = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: `${process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'}/api/auth/auth0/callback`,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      scope: 'openid profile email offline_access',
      audience: audience || `https://${auth0Domain}/userinfo`,
    });

    // Add state parameter for CSRF protection
    const state = generateState();
    response.cookies.set('auth0_state', state, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 60 * 10, // 10 minutes expiry for CSRF protection
      path: '/api/auth/auth0/callback',
    });

    if (callbackUrl) {
      authParams.set('state', state);
      authParams.set('redirect_uri_after_login', callbackUrl);
    } else {
      authParams.set('state', state);
    }

    const authUrl = `https://${auth0Domain}/authorize?${authParams.toString()}`;

    return NextResponse.redirect(authUrl);
  } catch (error) {
    console.error('Auth0 login error:', error);
    return NextResponse.redirect(
      `${process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'}/auth/signup?error=login_failed`
    );
  }
}

/**
 * Generate a PKCE code verifier (43-128 characters, URL-safe base64)
 */
function generateCodeVerifier(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return base64UrlEncode(array);
}

/**
 * Generate PKCE code challenge from verifier using SHA-256 hash
 */
async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = new Uint8Array(hashBuffer);
  return base64UrlEncode(hashArray);
}

/**
 * Encode buffer as URL-safe Base64 (removes padding)
 */
function base64UrlEncode(buffer: Uint8Array): string {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000; // 32KB chunks to avoid stack overflow
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Generate a random state parameter for CSRF protection
 */
function generateState(): string {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
}
