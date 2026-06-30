/**
 * Password Strength Check Endpoint (TOUR-141)
 * 
 * Allows clients to check if a password meets policy before submitting it.
 * Used by frontend forms for real-time feedback during signup and password changes.
 */

import { NextRequest, NextResponse } from 'next/server';
import { validatePasswordPolicy, getPasswordStrengthLabel, PASSWORD_POLICY } from '@/lib/auth';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { password } = body;

    if (!password || typeof password !== 'string') {
      return NextResponse.json(
        { error: 'Password is required' },
        { status: 400 }
      );
    }

    // Validate against policy
    const result = validatePasswordPolicy(password);
    
    // Generate specific suggestions for improvement
    const suggestions: string[] = [];
    
    if (password.length < PASSWORD_POLICY.minLength) {
      suggestions.push(`Add at least ${PASSWORD_POLICY.minLength} characters`);
    }
    
    if (!/[A-Z]/.test(password)) {
      suggestions.push('Add an uppercase letter');
    }
    
    if (!/[a-z]/.test(password)) {
      suggestions.push('Add a lowercase letter');
    }
    
    if (!/\d/.test(password)) {
      suggestions.push('Add a number');
    }
    
    if (PASSWORD_POLICY.specialChars.test(password) === false) {
      suggestions.push('Add a special character (!@#$%^&*)');
    }

    // Provide recommendations based on score
    const strength = getPasswordStrengthLabel(result.score);
    let recommendation = '';
    
    switch (strength) {
      case 'weak':
        recommendation = 'This password is too weak. Consider using a longer, more complex password.';
        break;
      case 'fair':
        recommendation = 'This password could be stronger. Try adding numbers and special characters.';
        break;
      case 'good':
        recommendation = 'This is a good password! Adding more character types would make it even stronger.';
        break;
      case 'strong':
        recommendation = 'Excellent! This password meets all enterprise security requirements.';
        break;
    }

    return NextResponse.json({
      valid: result.valid,
      score: result.score,
      strength,
      errors: result.errors,
      suggestions,
      recommendation,
      policy: {
        minLength: PASSWORD_POLICY.minLength,
        requireUppercase: PASSWORD_POLICY.requireUppercase,
        requireLowercase: PASSWORD_POLICY.requireLowercase,
        requireNumber: PASSWORD_POLICY.requireNumber,
        requireSpecialChar: PASSWORD_POLICY.requireSpecialChar,
        passwordExpirationDays: PASSWORD_POLICY.passwordExpirationDays,
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

// Support GET requests for simple policy info
export async function GET() {
  return NextResponse.json({
    policy: {
      minLength: PASSWORD_POLICY.minLength,
      requireUppercase: PASSWORD_POLICY.requireUppercase,
      requireLowercase: PASSWORD_POLICY.requireLowercase,
      requireNumber: PASSWORD_POLICY.requireNumber,
      requireSpecialChar: PASSWORD_POLICY.requireSpecialChar,
      passwordExpirationDays: PASSWORD_POLICY.passwordExpirationDays,
      reminderDaysBeforeExpiry: PASSWORD_POLICY.reminderDaysBeforeExpiry,
    },
  });
}
