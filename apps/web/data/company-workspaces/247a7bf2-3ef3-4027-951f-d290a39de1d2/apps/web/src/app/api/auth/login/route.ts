import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { eq } from 'drizzle-orm';
import { db, users } from '@tourbillon/db';
import { generateSessionToken, verifyPassword, isValidEmail, isPasswordExpired, PASSWORD_POLICY } from '@/lib/auth';

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

    if (!isValidEmail(email)) {
      return NextResponse.json(
        { error: 'Invalid email format' },
        { status: 400 }
      );
    }

    // Query user from PostgreSQL instead of JSON file
    const user = await db.query.users.findFirst({
      where: eq(users.email, email.toLowerCase()),
    });

    if (!user || !user.passwordHash) {
      // Return generic error to prevent email enumeration
      return NextResponse.json(
        { error: 'Invalid email or password' },
        { status: 401 }
      );
    }

    // Verify password using shared utility (scrypt format)
    const isValid = verifyPassword(password, user.passwordHash);
    if (!isValid) {
      return NextResponse.json(
        { error: 'Invalid email or password' },
        { status: 401 }
      );
    }

    // Check password expiration (TOUR-141) - only for non-OAuth users
    const isExpired = user.passwordChangedAt && isPasswordExpired(user.passwordChangedAt);
    const mustReset = user.mustResetPassword === true;

    if (isExpired || mustReset) {
      // Don't generate session yet — require password change first
      return NextResponse.json({
        message: 'Password reset required',
        requiresPasswordChange: true,
        reason: isExpired ? 'Your password has expired. Please choose a new one.' : 'Your password needs to be updated.',
      }, { status: 403 });
    }

    // Generate session token and set cookie
    const token = generateSessionToken(user.id, user.provider || 'email');
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
