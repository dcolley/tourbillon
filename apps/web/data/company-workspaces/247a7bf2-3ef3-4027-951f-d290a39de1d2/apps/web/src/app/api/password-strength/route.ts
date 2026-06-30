/**
 * Password Strength Check Endpoint (TOUR-141)
 * 
 * Provides real-time password strength analysis without storing the password.
 * Used by frontend signup form for live feedback.
 */

import { NextRequest, NextResponse } from 'next/server';
import { validatePasswordPolicy, getPasswordStrengthLabel } from '@/lib/auth';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { password } = body;

    // Validation
    if (!password || typeof password !== 'string') {
      return NextResponse.json(
        { error: 'Password is required' },
        { status: 400 }
      );
    }

    const result = validatePasswordPolicy(password);
    const strengthLabel = getPasswordStrengthLabel(result.score);

    return NextResponse.json({
      valid: result.valid,
      score: result.score,
      strength: strengthLabel,
      errors: result.errors,
      feedback: {
        minLength: password.length >= 8 ? true : false,
        hasUppercase: /[A-Z]/.test(password),
        hasLowercase: /[a-z]/.test(password),
        hasNumber: /\d/.test(password),
        hasSpecialChar: /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?~`]/.test(password),
      },
    });
  } catch (error) {
    console.error('Password strength check error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
