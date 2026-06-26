import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { scryptSync, timingSafeEqual } from 'crypto';

const USERS_FILE = '/tmp/tourbillon_users.json';

// --- Helper: Read/write users store (JSON file) ---
function readUsers(): Array<{ id: string; email: string; passwordHash?: string }> {
  try {
    const fs = require('fs');
    if (!fs.existsSync(USERS_FILE)) return [];
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

// --- Helper: Generate a signed session token (HMAC-SHA256) ---
function generateSessionToken(userId: string): string {
  const secret = process.env.SESSION_SECRET || 'dev-session-secret-change-in-production';
  const payload = JSON.stringify({ userId, iat: Date.now(), provider: 'email' });
  const crypto = require('crypto');
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(payload);
  return `${payload}.${hmac.digest('hex')}`;
}

// --- Helper: Verify a password against a stored hash ---
function verifyPassword(password: string, storedHash: string): boolean {
  const [salt, hash] = storedHash.split(':');
  if (!salt || !hash) return false;
  const derivedKey = scryptSync(password, salt, 64);
  const storedKey = Buffer.from(hash, 'hex');
  return timingSafeEqual(derivedKey, storedKey);
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { email, password } = body;

    // Validation
    if (!email || !password) {
      return NextResponse.json(
        { error: 'Email and password are required' },
        { status: 400 }
      );
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return NextResponse.json(
        { error: 'Invalid email format' },
        { status: 400 }
      );
    }

    // Check for existing user with password hash
    const users = readUsers();
    const user = users.find(u => u.email.toLowerCase() === email.toLowerCase());

    if (!user || !user.passwordHash) {
      // Return generic error to prevent email enumeration
      return NextResponse.json(
        { error: 'Invalid email or password' },
        { status: 401 }
      );
    }

    // Verify password
    const isValid = verifyPassword(password, user.passwordHash);
    if (!isValid) {
      return NextResponse.json(
        { error: 'Invalid email or password' },
        { status: 401 }
      );
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

    return NextResponse.json({
      message: 'Login successful',
      user: { id: user.id, email: user.email },
    });
  } catch (error) {
    console.error('Login error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
