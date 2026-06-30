import { NextRequest, NextResponse } from 'next/server';

const USERS_FILE = '/tmp/tourbillon_users.json';

// --- Helper: Read/write users store (JSON file) ---
function readUsers(): Array<{ 
  id: string; 
  email: string; 
  name?: string; 
  picture?: string; 
  auth0Id?: string;
  provider?: 'auth0' | 'github' | 'google' | 'email';
}> {
  try {
    const fs = require('fs');
    if (!fs.existsSync(USERS_FILE)) return [];
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function writeUsers(users: Array<{ 
  id: string; 
  email: string; 
  name?: string; 
  picture?: string; 
  auth0Id?: string;
  provider?: 'auth0' | 'github' | 'google' | 'email';
}>) {
  const fs = require('fs');
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// --- Helper: Generate a signed session token (HMAC-SHA256) ---
function generateSessionToken(userId: string): string {
  const secret = process.env.SESSION_SECRET || 'dev-session-secret-change-in-production';
  const payload = JSON.stringify({ userId, iat: Date.now(), provider: 'auth0' });
  const crypto = require('crypto');
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(payload);
  return `${payload}.${hmac.digest('hex')}`;
}

// --- JWKS Cache for performance ---
interface JWKSCache {
  keys: any[];
  fetchedAt: number;
}

let jwksCache: JWKSCache | null = null;
const JWKS_CACHE_TTL_MS = 6 * 3600 * 1000; // Cache for 6 hours (Auth0 rotates keys infrequently)

async function getJWKSKeys(): Promise<any[]> {
  if (jwksCache && (Date.now() - jwksCache.fetchedAt) < JWKS_CACHE_TTL_MS && jwksCache.keys.length > 0) {
    return jwksCache.keys;
  }

  const auth0Domain = process.env.AUTH0_DOMAIN || 'dev.auth0.com';
  const jwksUrl = `https://${auth0Domain}/.well-known/jwks.json`;

  try {
    console.log(`Fetching JWKS from ${jwksUrl}`);
    const response = await fetch(jwksUrl, { 
      cache: 'no-store',
      signal: AbortSignal.timeout(10000) // 10 second timeout
    });
    
    if (!response.ok) {
      console.error(`Failed to fetch JWKS: ${response.status}`);
      return [];
    }

    const data = await response.json();
    jwksCache = { keys: data.keys, fetchedAt: Date.now() };
    return data.keys;
  } catch (error) {
    console.error('Failed to fetch JWKS:', error);
    // Return empty array - JWT verification will fail safely below
    return [];
  }
}

// --- Helper: Verify and decode JWT using JWKS keys ---
async function verifyJWT(token: string, jwksKeys: any[]): Promise<any | null> {
  try {
    // Split the token into parts (header.payload.signature)
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [headerB64, payloadB64] = parts;

    // Decode header to get key ID and algorithm
    const headerJson = Buffer.from(headerB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    const header = JSON.parse(headerJson.toString('utf-8'));
    
    const kid = header.kid;
    if (!kid) {
      console.error('JWT missing key ID (kid) in header');
      return null;
    }

    // Find the matching public key from JWKS
    const jwk = jwksKeys.find((key: any) => key.kid === kid);
    if (!jwk) {
      console.error(`JWK with kid=${kid} not found in JWKS`);
      return null;
    }

    // Use Web Crypto API to verify the signature
    const encoder = new TextEncoder();
    const signingInput = encoder.encode(`${headerB64}.${payloadB64}`);

    // Convert JWK public key to CryptoKey using subtle.importKey
    const cryptoKey = await crypto.subtle.importKey(
      'jwk',
      {
        kty: jwk.kty,
        n: jwk.n.replace(/-/g, '+').replace(/_/g, '/'), // Convert URL-safe base64 to standard
        e: jwk.e.replace(/-/g, '+').replace(/_/g, '/'),
        alg: header.alg || 'RS256',
      },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      true, // extractable = false (public key)
      ['verify']
    );

    // Decode signature from the JWT
    const signatureBytes = Buffer.from(
      parts[2].replace(/-/g, '+').replace(/_/g, '/'), 
      'base64'
    );

    // Verify using Web Crypto API
    const isValid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      cryptoKey,
      signatureBytes,
      signingInput
    );

    if (!isValid) {
      console.error('JWT signature verification failed');
      return null;
    }

    // Decode and validate the payload
    const payloadJson = Buffer.from(
      payloadB64.replace(/-/g, '+').replace(/_/g, '/'), 
      'base64'
    ).toString('utf-8');
    
    let payload: any;
    try {
      payload = JSON.parse(payloadJson);
    } catch (e) {
      console.error('Failed to parse JWT payload:', e);
      return null;
    }

    // Validate required claims
    const now = Math.floor(Date.now() / 1000);
    
    if (!payload.sub) {
      console.error('JWT missing subject claim (sub)');
      return null;
    }

    if (payload.exp && payload.exp < now) {
      console.error('JWT has expired');
      return null;
    }

    // Validate issuer (optional but recommended)
    const auth0Domain = process.env.AUTH0_DOMAIN || 'dev.auth0.com';
    if (payload.iss !== `https://${auth0Domain}/`) {
      console.warn(`JWT issuer mismatch: expected https://${auth0Domain}/, got ${payload.iss}`);
    }

    return payload;
  } catch (error) {
    console.error('JWT verification error:', error);
    return null;
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const code = searchParams.get('code');
    const state = searchParams.get('state');
    const error = searchParams.get('error');

    // Check for Auth0 errors first
    if (error) {
      console.error(`Auth0 callback error: ${error} - ${searchParams.get('error_description')}`);
      return NextResponse.redirect(
        `${process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'}?auth_error=auth0_denied`
      );
    }

    // Validate code is present
    if (!code) {
      console.error('Authorization code missing from callback');
      return NextResponse.redirect(
        `${process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'}?auth_error=missing_code`
      );
    }

    // Validate CSRF state parameter
    const storedState = request.cookies.get('auth0_state')?.value;
    if (!storedState || !state || storedState !== state) {
      console.error('Auth0 callback: Invalid or missing state parameter (CSRF protection failed)');
      return NextResponse.redirect(
        `${process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'}?auth_error=invalid_state`
      );
    }

    // Get PKCE code verifier from cookie for token exchange
    const codeVerifier = request.cookies.get('auth0_code_verifier')?.value;
    if (!codeVerifier) {
      console.error('Auth0 callback: Code verifier missing (CSRF protection failed)');
      return NextResponse.redirect(
        `${process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'}?auth_error=invalid_state`
      );
    }

    // Required environment variables
    const auth0Domain = process.env.AUTH0_DOMAIN;
    const clientId = process.env.AUTH0_CLIENT_ID;
    const clientSecret = process.env.AUTH0_CLIENT_SECRET;
    
    if (!auth0Domain || !clientId) {
      console.error('Auth0 configuration missing');
      return NextResponse.redirect(
        `${process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'}?auth_error=auth_config_missing`
      );
    }

    // Exchange authorization code for tokens (with PKCE verification)
    const tokenUrl = `https://${auth0Domain}/oauth/token`;
    
    console.log(`Exchanging Auth0 code for token with client_secret ${clientSecret ? 'present' : 'missing'}...`);
    
    let tokenResponse;
    
    // For public clients (no client_secret), don't include it in the request
    if (clientSecret) {
      tokenResponse = await fetch(tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: `${process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'}/api/auth/auth0/callback`,
          code_verifier: codeVerifier, // PKCE verification
        }),
      });
    } else {
      console.warn('AUTH0_CLIENT_SECRET not set - using public client flow (less secure)');
      tokenResponse = await fetch(tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: clientId,
          code,
          redirect_uri: `${process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'}/api/auth/auth0/callback`,
          code_verifier: codeVerifier, // PKCE verification still required for public clients
        }),
      });
    }

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      console.error('Auth0 token exchange failed:', tokenResponse.status, errorText);
      return NextResponse.redirect(
        `${process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'}?auth_error=token_exchange_failed`
      );
    }

    const tokenData = await tokenResponse.json();

    if (!tokenData.access_token && !tokenData.id_token) {
      console.error('No tokens received from Auth0');
      return NextResponse.redirect(
        `${process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'}?auth_error=no_tokens`
      );
    }

    // Verify and decode the ID token (JWT)
    const jwksKeys = await getJWKSKeys();
    
    if (!jwksKeys.length) {
      console.error('Failed to fetch JWKS keys - cannot verify JWT');
      return NextResponse.redirect(
        `${process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'}?auth_error=jwks_fetch_failed`
      );
    }

    const idToken = tokenData.id_token;
    if (!idToken) {
      console.error('Auth0 callback: ID token missing');
      return NextResponse.redirect(
        `${process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'}?auth_error=missing_id_token`
      );
    }

    const payload = await verifyJWT(idToken, jwksKeys);
    
    if (!payload) {
      console.error('Auth0 callback: JWT verification failed');
      return NextResponse.redirect(
        `${process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'}?auth_error=jwt_verification_failed`
      );
    }

    // Extract user profile from JWT claims
    const auth0Id = payload.sub; // Unique Auth0 user ID (format: auth0|123456)
    let email = payload.email || payload['https://tourbillon.io/email'];
    let name = payload.name || payload.nickname || 'Auth0 User';
    let picture = payload.picture;

    if (!email) {
      console.error('Auth0 callback: No email found in JWT');
      return NextResponse.redirect(
        `${process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'}?auth_error=missing_email`
      );
    }

    // Find or create user in the local database (JSON file store)
    const users = readUsers();
    
    // First try to find by Auth0 ID (primary lookup for Auth0 users)
    let user = users.find((u: any) => u.auth0Id === auth0Id);

    if (!user) {
      // Try fallback: find by email across all providers
      const existingByEmail = users.find(
        (u: any) => u.email.toLowerCase() === email.toLowerCase()
      );

      if (existingByEmail) {
        // Link Auth0 provider to existing user account
        console.log(`Linking Auth0 account (${auth0Id}) to existing user ${email}`);
        
        // Preserve the original password hash if it exists (for login fallback)
        const newUser = {
          ...existingByEmail,
          auth0Id,
          provider: 'auth0',
          name: existingByEmail.name || name,
          picture: existingByEmail.picture || picture,
        };
        
        // Replace the old entry with updated one
        user = users.find((u: any) => u.id === existingByEmail.id);
        if (user) {
          Object.assign(user, newUser);
        }
      } else {
        // New user - auto-create account on first login
        console.log(`Creating new Auth0 user: ${email} (${auth0Id})`);
        
        const userId = `user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        user = {
          id: userId,
          email,
          name,
          picture,
          auth0Id,
          provider: 'auth0',
        };
        
        users.push(user);
        writeUsers(users);
      }
    } else {
      // Existing Auth0 user - update profile info (name/picture may change)
      if (user.name !== name || user.picture !== picture) {
        console.log(`Updating existing Auth0 user: ${email}`);
        Object.assign(user, { name, picture });
        writeUsers(users);
      }
    }

    // Generate session token and set cookie
    const sessionToken = generateSessionToken(user.id);
    const cookieStore = cookies();
    cookieStore.set('session', sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 7, // 1 week
      path: '/',
    });

    // Clear the state and code_verifier cookies (one-time use)
    cookieStore.delete('auth0_state');
    cookieStore.delete('auth0_code_verifier');

    // Determine redirect URL from callbackUrl parameter or default to home
    const callbackUrl = searchParams.get('redirect_uri_after_login');
    const redirectTarget = callbackUrl || process.env.NEXT_PUBLIC_BASE_URL || '/';

    return NextResponse.redirect(redirectTarget);
  } catch (error) {
    console.error('Auth0 callback error:', error);
    return NextResponse.redirect(
      `${process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'}?auth_error=callback_failed`
    );
  }
}
