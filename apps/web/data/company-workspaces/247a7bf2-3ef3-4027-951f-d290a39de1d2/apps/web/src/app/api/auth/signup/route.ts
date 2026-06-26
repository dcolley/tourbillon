import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { scryptSync, randomBytes, timingSafeEqual } from 'crypto';

const USERS_FILE = '/tmp/tourbillon_users.json';

// --- Helper: Read/write users store (JSON file) ---
function readUsers(): Array<{ id: string; email: string; passwordHash: string }> {
  try {
    const fs = require('fs');
    if (!fs.existsSync(USERS_FILE)) return [];
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function writeUsers(users: Array<{ id: string; email: string; passwordHash: string }>) {
  const fs = require('fs');
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// --- Helper: Hash a password ---
function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

// --- Helper: Verify a password against a stored hash ---
function verifyPassword(password: string, storedHash: string): boolean {
  const [salt, hash] = storedHash.split(':');
  if (!salt || !hash) return false;
  const derivedKey = scryptSync(password, salt, 64);
  const storedKey = Buffer.from(hash, 'hex');
  return timingSafeEqual(derivedKey, storedKey);
}

// --- Helper: Generate a signed session token (HMAC-SHA256) ---
function generateSessionToken(userId: string): string {
  const secret = process.env.SESSION_SECRET || 'dev-session-secret-change-in-production';
  const payload = JSON.stringify({ userId, iat: Date.now() });
  const crypto = require('crypto');
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(payload);
  return `${payload}.${hmac.digest('hex')}`;
}

// --- Helper: Verify a session token and extract user ID ---
function verifySessionToken(token: string): { userId: string } | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, signature] = parts;
  const secret = process.env.SESSION_SECRET || 'dev-session-secret-change-in-production';
  const crypto = require('crypto');
  const hmac = crypto.createHmac('sha256', secret);
  const expectedSignature = hmac.update(payload).digest('hex');
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) return null;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
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

    if (password.length < 6) {
      return NextResponse.json(
        { error: 'Password must be at least 6 characters long' },
        { status: 400 }
      );
    }

    // Check for existing user
    const users = readUsers();
    const existingUser = users.find(u => u.email.toLowerCase() === email.toLowerCase());
    if (existingUser) {
      return NextResponse.json(
        { error: 'An account with this email already exists' },
        { status: 409 }
      );
    }

    // Create new user
    const userId = `user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const passwordHash = hashPassword(password);
    const newUser = { id: userId, email: email.toLowerCase(), passwordHash };
    users.push(newUser);
    writeUsers(users);

    // Generate session token and set cookie
    const token = generateSessionToken(userId);
    const cookieStore = cookies();
    cookieStore.set('session', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 7, // 1 week
      path: '/',
    });

    return NextResponse.json({
      message: 'User created successfully',
      user: { id: newUser.id, email: newUser.email },
    }, { status: 201 });
  } catch (error) {
    console.error('Signup error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
