import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { timingSafeEqual } from 'crypto';

// --- Helper: Verify a session token and extract user info ---
function verifySessionToken(token: string) {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, signature] = parts;
  const secret = process.env.SESSION_SECRET || 'dev-session-secret-change-in-production';
  try {
    const parsed = JSON.parse(payload);
    
    // Verify HMAC signature
    const crypto = require('crypto');
    const hmac = crypto.createHmac('sha256', secret);
    const expectedSignature = hmac.update(payload).digest('hex');
    if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) return null;

    // Check token age (1 week max, same as cookie expiry)
    if (parsed.iat && Date.now() - parsed.iat > 7 * 24 * 60 * 60 * 1000) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

// --- Helper: Read users store (JSON file) ---
function readUsers() {
  try {
    const fs = require('fs');
    if (!fs.existsSync('/tmp/tourbillon_users.json')) return [];
    return JSON.parse(fs.readFileSync('/tmp/tourbillon_users.json', 'utf-8'));
  } catch {
    return [];
  }
}

export async function GET(request: NextRequest) {
  try {
    const cookieStore = cookies();
    const sessionToken = cookieStore.get('session');

    if (!sessionToken || !sessionToken.value) {
      return NextResponse.json(
        { error: 'No active session', isAuthenticated: false },
        { status: 401 }
      );
    }

    // Verify token and extract user ID + provider info
    const tokenData = verifySessionToken(sessionToken.value);
    if (!tokenData) {
      return NextResponse.json(
        { error: 'Invalid session', isAuthenticated: false },
        { status: 401 }
      );
    }

    // Fetch user data from store
    const users = readUsers();
    const user = users.find((u: any) => u.id === tokenData.userId);

    if (!user) {
      return NextResponse.json(
        { error: 'User not found', isAuthenticated: false },
        { status: 401 }
      );
    }

    // Return user info without sensitive data (no password hash)
    const userInfo = {
      id: user.id,
      email: user.email,
      name: user.name || null,
      provider: tokenData.provider || 'email',
    };

    return NextResponse.json({
      message: 'Session verified',
      isAuthenticated: true,
      user: userInfo,
    });
  } catch (error) {
    console.error('Session check error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
