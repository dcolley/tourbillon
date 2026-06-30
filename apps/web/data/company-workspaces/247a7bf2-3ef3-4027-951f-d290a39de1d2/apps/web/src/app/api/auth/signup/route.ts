/**
 * Signup Endpoint - Password Policy Enforcement (TOUR-141)
 * 
 * Enforces enterprise password policy on user registration:
 * - Minimum 8 characters
 * - Must contain uppercase, lowercase, number, and special character
 * - Sets password timestamp for expiration tracking
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { eq } from 'drizzle-orm';
import { db, findUserByEmail } from '@tourbillon/db';
import { users } from '@tourbillon/db/schema';
import { validatePasswordPolicy, hashPassword, generateSessionToken } from '@/lib/auth';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { email, password, name } = body;

    // Basic validation
    if (!email || !password) {
      return NextResponse.json(
        { error: 'Email and password are required' },
        { status: 400 }
      );
    }

    // Email format check
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return NextResponse.json(
        { error: 'Invalid email format' },
        { status: 400 }
      );
    }

    // Password policy validation (TOUR-141)
    const passwordValidation = validatePasswordPolicy(password);
    if (!passwordValidation.valid) {
      return NextResponse.json(
        { 
          error: 'Password does not meet security requirements',
          details: passwordValidation.errors,
          score: passwordValidation.score
        },
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

    // Create new user with password policy enforcement
    const passwordHash = hashPassword(password);
    
    // Insert user into database with password timestamp for expiration tracking (TOUR-141)
    const newUser = await db.insert(users).values({
      email: email.toLowerCase(),
      passwordHash,
      name: name || null,
      provider: 'email',
      mustResetPassword: false,
      passwordExpired: false,
      passwordChangedAt: new Date(), // Track when password was set for 90-day expiration (TOUR-141)
    }).returning({ id: users.id, email: users.email });

    if (!newUser || newUser.length === 0) {
      return NextResponse.json(
        { error: 'Failed to create user' },
        { status: 500 }
      );
    }

    // Generate session token and set cookie
    const token = generateSessionToken(newUser[0].id, 'email');
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
