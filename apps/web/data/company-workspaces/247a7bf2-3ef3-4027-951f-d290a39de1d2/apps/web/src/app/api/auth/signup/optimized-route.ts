/**
 * Optimized Signup Endpoint - Using PostgreSQL with Async Queries
 * 
 * This file replaces the synchronous file-based signup implementation
 * with async database queries and bcrypt password hashing.
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { eq } from 'drizzle-orm';
import { db, findUserByEmail, createUser, createSession } from '@tourbillon/db';
import bcrypt from 'bcryptjs';

export async function POST(request: NextRequest) {
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

    // Check for existing user using indexed query O(log n) instead of O(n)
    const existingUser = await findUserByEmail(email);
    if (existingUser) {
      return NextResponse.json(
        { error: 'An account with this email already exists' },
        { status: 409 }
      );
    }

    // Create new user with async bcrypt hashing (work factor 12 for security)
    const passwordHash = await bcrypt.hash(password, 12);
    const newUser = await createUser({ email, passwordHash, name });

    if (!newUser || newUser.length === 0) {
      return NextResponse.json(
        { error: 'Failed to create user' },
        { status: 500 }
      );
    }

    // Generate session token (async HMAC operation via Web Crypto API)
    const token = await generateSessionToken(newUser[0].id);
    
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

// Generate session token using async Web Crypto API
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
