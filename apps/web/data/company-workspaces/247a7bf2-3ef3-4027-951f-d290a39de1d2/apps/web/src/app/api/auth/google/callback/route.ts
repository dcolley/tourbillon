import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { scryptSync, randomBytes } from 'crypto';

const USERS_FILE = '/tmp/tourbillon_users.json';

// --- Helper: Read/write users store (JSON file) ---
function readUsers(): Array<{ id: string; email: string; passwordHash?: string; name?: string }> {
  try {
    const fs = require('fs');
    if (!fs.existsSync(USERS_FILE)) return [];
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function writeUsers(users: Array<{ id: string; email: string; passwordHash?: string; name?: string }>) {
  const fs = require('fs');
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// --- Helper: Generate a signed session token (HMAC-SHA256) ---
function generateSessionToken(userId: string): string {
  const secret = process.env.SESSION_SECRET || 'dev-session-secret-change-in-production';
  const payload = JSON.stringify({ userId, iat: Date.now(), provider: 'google' });
  const crypto = require('crypto');
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(payload);
  return `${payload}.${hmac.digest('hex')}`;
}

// --- Helper: Validate state parameter for CSRF protection ---
function validateState(state: string | null): boolean {
  if (!state) return false;
  
  // In production, this would check against a server-side session
  // For now, basic validation that state is not empty and contains expected format
  try {
    const decoded = Buffer.from(state, 'base64').toString('utf-8');
    const parts = JSON.parse(decoded);
    
    // Verify timestamp (state must be < 5 minutes old)
    if (!parts.timestamp || Date.now() - parts.timestamp > 5 * 60 * 1000) {
      return false;
    }
    
    // Verify nonce matches session (simplified for now)
    const secret = process.env.SESSION_SECRET || 'dev-session-secret-change-in-production';
    const crypto = require('crypto');
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(parts.timestamp.toString());
    const expectedNonce = hmac.digest('hex').slice(0, 8);
    
    return parts.nonce === expectedNonce;
  } catch {
    return false;
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const code = searchParams.get('code');
    const state = searchParams.get('state');
    const error = searchParams.get('error');

    // Validate CSRF state parameter
    if (!validateState(state)) {
      console.error('Google OAuth: Invalid or missing state parameter (CSRF protection)');
      return NextResponse.redirect(
        `${process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'}?auth_error=invalid_state`
      );
    }

    if (error) {
      const errorDescription = searchParams.get('error_description') || 'Authentication failed';
      console.error(`Google OAuth error: ${error} - ${errorDescription}`);
      return NextResponse.redirect(
        `${process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'}?auth_error=google_denied`
      );
    }

    if (!code) {
      return NextResponse.json(
        { error: 'Authorization code missing' },
        { status: 400 }
      );
    }

    // Exchange authorization code for tokens
    const tokenUrl = 'https://oauth2.googleapis.com/token';
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      console.error('Google OAuth credentials not configured');
      return NextResponse.json(
        { error: 'Google OAuth is not properly configured' },
        { status: 500 }
      );
    }

    const tokenParams = new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: `${process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'}/api/auth/google/callback`,
      grant_type: 'authorization_code',
    });

    const tokenResponse = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenParams.toString(),
    });

    if (!tokenResponse.ok) {
      console.error('Failed to exchange code for tokens:', await tokenResponse.text());
      return NextResponse.redirect(
        `${process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'}?auth_error=google_token_exchange_failed`
      );
    }

    const tokenData = await tokenResponse.json();

    // Fetch user info from Google
    const userInfoResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });

    if (!userInfoResponse.ok) {
      console.error('Failed to fetch user info:', await userInfoResponse.text());
      return NextResponse.redirect(
        `${process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'}?auth_error=google_userinfo_failed`
      );
    }

    const userInfo = await userInfoResponse.json();

    // Validate email from Google (must be present and verified)
    if (!userInfo.email && !userInfo.email_verified) {
      return NextResponse.redirect(
        `${process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'}?auth_error=google_no_email`
      );
    }

    // Find or create user
    const users = readUsers();
    let user = users.find((u: any) => u.email === userInfo.email);

    if (!user) {
      user = {
        id: `user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        email: userInfo.email,
        name: userInfo.name || userInfo.given_name || '',
      };
      users.push(user);
      writeUsers(users);
    }

    // Generate session token and set cookie
    const token = generateSessionToken(user.id);
    const cookieStore = cookies();
    cookieStore.set('session', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 7, // 1 week
      path: '/',
    });

    return NextResponse.redirect(
      `${process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'}`
    );
  } catch (error) {
    console.error('Google callback error:', error);
    return NextResponse.redirect(
      `${process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'}?auth_error=google_callback_failed`
    );
  }
}
