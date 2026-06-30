/**
 * Password Expiry Check Endpoint (TOUR-141)
 * 
 * Returns the password expiry status for a user, including:
 * - Whether the password is expired
 * - Days remaining until expiration (if not expired)
 * - Reminder flag if within 14-day warning window
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { eq } from 'drizzle-orm';
import { db, users } from '@tourbillon/db';
import { verifySessionToken, isPasswordExpired, isPasswordExpiringSoon, PASSWORD_POLICY } from '@/lib/auth';

export async function GET(request: NextRequest) {
  try {
    // Get session token from cookie
    const sessionCookie = request.cookies.get('session')?.value;
    
    if (!sessionCookie) {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      );
    }

    // Verify session and extract user ID
    const payload = verifySessionToken(sessionCookie);
    
    if (!payload) {
      return NextResponse.json(
        { error: 'Invalid or expired session' },
        { status: 401 }
      );
    }

    // Fetch user from database
    const user = await db.query.users.findFirst({
      where: eq(users.id, payload.userId),
      columns: {
        email: true,
        provider: true,
        passwordChangedAt: true,
        mustResetPassword: true,
        passwordExpired: true,
      },
    });

    if (!user) {
      return NextResponse.json(
        { error: 'User not found' },
        { status: 404 }
      );
    }

    // Auth0 users don't need local password expiry tracking
    if (user.provider === 'auth0' || user.provider === 'github' || user.provider === 'google') {
      return NextResponse.json({
        requiresPasswordChange: false,
        isExpired: false,
        provider: user.provider,
        message: `Using ${user.provider} authentication — local password policy does not apply.`,
      });
    }

    // Check password expiry status
    let isExpired = false;
    let daysRemaining = 0;
    let reminderDaysLeft = 0;
    
    if (user.mustResetPassword) {
      isExpired = true;
    } else if (user.passwordChangedAt && user.provider === 'email') {
      const expiredCheck = isPasswordExpired(user.passwordChangedAt);
      
      // Calculate days remaining
      const expiryDate = new Date(user.passwordChangedAt);
      expiryDate.setDate(expiryDate.getDate() + PASSWORD_POLICY.passwordExpirationDays);
      const now = new Date();
      const diffMs = expiryDate.getTime() - now.getTime();
      daysRemaining = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
      
      if (daysRemaining < 0) {
        isExpired = true;
        daysRemaining = 0;
      }
      
      // Check if reminder should be triggered
      const expiringSoon = isPasswordExpiringSoon(user.passwordChangedAt);
      if (expiringSoon && !isExpired) {
        reminderDaysLeft = Math.ceil(daysRemaining);
      }
    }

    let message: string;
    
    if (user.mustResetPassword) {
      message = 'Your password must be reset immediately. Please update your password.';
    } else if (isExpired) {
      message = `Your password has expired (${daysRemaining} days ago). Please update your password.`;
    } else if (reminderDaysLeft > 0 && reminderDaysLeft <= PASSWORD_POLICY.reminderDaysBeforeExpiry) {
      message = `Your password will expire in ${reminderDaysLeft} day${reminderDaysLeft !== 1 ? 's' : ''}. Consider updating it soon.`;
    } else if (daysRemaining > 0) {
      message = `${daysRemaining} days remaining until your password expires on ${new Date(new Date().setDate(new Date().getDate() + daysRemaining)).toLocaleDateString()}.`;
    } else {
      message = 'Your password is up to date.';
    }

    return NextResponse.json({
      requiresPasswordChange: user.mustResetPassword || isExpired,
      isExpired,
      expiringSoon: reminderDaysLeft > 0 && !isExpired,
      daysRemaining: Math.max(0, daysRemaining),
      reminderThreshold: PASSWORD_POLICY.reminderDaysBeforeExpiry,
      expirationDate: user.passwordChangedAt 
        ? new Date(new Date(user.passwordChangedAt).setDate(new Date(user.passwordChangedAt).getDate() + PASSWORD_POLICY.passwordExpirationDays)).toISOString() 
        : null,
      passwordChangedAt: user.passwordChangedAt,
      provider: user.provider || 'email',
      message,
    });
  } catch (error) {
    console.error('Password expiry check error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
