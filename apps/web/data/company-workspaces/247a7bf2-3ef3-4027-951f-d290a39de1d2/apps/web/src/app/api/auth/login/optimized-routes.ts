/**
 * Optimized API Endpoints - Using PostgreSQL with Async Queries
 * 
 * This file demonstrates the refactored endpoints that replace the
 * synchronous file-based I/O with async database queries.
 * 
 * TODO: Replace these files in their respective locations after testing
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { eq } from 'drizzle-orm';
import { db, findUserByEmail, createUser, createSession } from '@tourbillon/db';
import bcrypt from 'bcryptjs';

// ============================================================================
// OPTIMIZED LOGIN ENDPOINT
// ============================================================================
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

    // Use indexed database query (O(log n) instead of O(n))
    const user = await findUserByEmail(email);

    if (!user || !user.passwordHash) {
      return NextResponse.json(
        { error: 'Invalid email or password' },
        { status: 401 }
      );
    }

    // Use bcrypt for async, non-blocking password verification
    const isValid = await bcrypt.compare(password, user.passwordHash);
    if (!isValid) {
      return NextResponse.json(
        { error: 'Invalid email or password' },
        { status: 401 }
      );
    }

    // Generate session token (async HMAC operation)
    const token = await generateSessionToken(user.id);
    
    // Set cookie with secure settings
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

// ============================================================================
// OPTIMIZED SIGNUP ENDPOINT  
export async function signupPOST(request: NextRequest) {
  try {
    const body = await request.json();
    const { email, password, name } = body;

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

    // Check for existing user using indexed query
    const existingUser = await findUserByEmail(email);
    if (existingUser) {
      return NextResponse.json(
        { error: 'An account with this email already exists' },
        { status: 409 }
      );
    }

    // Create new user with async bcrypt hashing
    const passwordHash = await bcrypt.hash(password, 12); // Work factor 12 for security
    const newUser = await createUser({ email, passwordHash, name });

    if (!newUser || newUser.length === 0) {
      return NextResponse.json(
        { error: 'Failed to create user' },
        { status: 500 }
      );
    }

    // Generate session token and set cookie
    const token = await generateSessionToken(newUser[0].id);
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
      user: { id: newUser[0].id, email: newUser[0].email },
    }, { status: 201 });
  } catch (error) {
    console.error('Signup error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

// ============================================================================
// OPTIMIZED SESSION VERIFICATION ENDPOINT
export async function sessionGET(request: NextRequest) {
  try {
    const cookieStore = cookies();
    const sessionToken = cookieStore.get('session');

    if (!sessionToken || !sessionToken.value) {
      return NextResponse.json(
        { error: 'No active session', isAuthenticated: false },
        { status: 401 }
      );
    }

    // Verify token (async HMAC operation)
    const tokenData = await verifySessionToken(sessionToken.value);
    if (!tokenData) {
      return NextResponse.json(
        { error: 'Invalid session', isAuthenticated: false },
        { status: 401 }
      );
    }

    // Fetch user from database using indexed lookup
    const user = await db.query.users.findFirst({
      where: (users, { eq }) => eq(users.id, tokenData.userId),
    });

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

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================
async function generateSessionToken(userId: string): Promise<string> {
  const secret = process.env.SESSION_SECRET || 'dev-session-secret-change-in-production';
  const payload = JSON.stringify({ userId, iat: Date.now(), provider: 'email' });
  
  // Use async crypto operation instead of synchronous HMAC
  const encoder = new TextEncoder();
  const keyData = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  
  const signature = await crypto.subtle.sign('HMAC', keyData, encoder.encode(payload));
  const signatureHex = Array.from(new Uint8Array(signature))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  
  return `${payload}.${signatureHex}`;
}

async function verifySessionToken(token: string): Promise<{ userId: string } | null> {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  
  const [payload, signature] = parts;
  const secret = process.env.SESSION_SECRET || 'dev-session-secret-change-in-production';
  
  try {
    const parsed = JSON.parse(payload);
    
    // Verify HMAC signature asynchronously
    const encoder = new TextEncoder();
    const keyData = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );
    
    const signatureBuffer = new Uint8Array(signature.match(/.{1,2}/g)?.map(byte => parseInt(byte, 16)) || []);
    const isValid = await crypto.subtle.verify('HMAC', keyData, signatureBuffer, encoder.encode(payload));
    
    if (!isValid) return null;

    // Check token age (1 week max)
    if (parsed.iat && Date.now() - parsed.iat > 7 * 24 * 60 * 60 * 1000) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}
