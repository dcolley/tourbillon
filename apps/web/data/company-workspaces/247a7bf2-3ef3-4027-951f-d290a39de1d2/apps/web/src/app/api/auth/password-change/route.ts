/**
 * Password Change Endpoint (TOUR-141)
 * 
 * Allows users to change their password with full policy enforcement.
 * Used by both expired-password forced-reset flow and voluntary changes.
 */

import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, findUserByEmail } from '@tourbillon/db';
import { users } from '@tourbillon/db/schema';
import { validatePasswordPolicy, verifyPassword, hashPassword } from '@/lib/auth';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { currentPassword, newPassword, email } = body;

    // Basic validation
    if (!email || !currentPassword || !newPassword) {
      return NextResponse.json(
        { error: 'Email, current password, and new password are required' },
        { status: 400 }
      );
    }

    // Validate new password meets policy (TOUR-141)
    const passwordValidation = validatePasswordPolicy(newPassword);
    if (!passwordValidation.valid) {
      return NextResponse.json(
        { 
          error: 'New password does not meet security requirements',
          details: passwordValidation.errors,
          score: passwordValidation.score
        },
        { status: 400 }
      );
    }

    // Find user by email (indexed query)
    const user = await findUserByEmail(email);
    
    if (!user || !user.passwordHash) {
      return NextResponse.json(
        { error: 'Invalid email or password' },
        { status: 401 }
      );
    }

    // Verify current password matches stored hash
    const isCurrentPasswordValid = verifyPassword(currentPassword, user.passwordHash);
    if (!isCurrentPasswordValid) {
      return NextResponse.json(
        { error: 'Current password is incorrect' },
        { status: 401 }
      );
    }

    // Update password hash and reset expiration timestamp (TOUR-141)
    const newPasswordHash = hashPassword(newPassword);
    
    await db.update(users)
      .set({
        passwordHash: newPasswordHash,
        mustResetPassword: false,  // Clear forced reset flag after successful change
        passwordExpired: false,    // Reset expiration timer
        passwordChangedAt: new Date(), // New timestamp for 90-day countdown
        updatedAt: new Date(),
      })
      .where(eq(users.email, email.toLowerCase()));

    return NextResponse.json({
      message: 'Password updated successfully',
    }, { status: 200 });
  } catch (error) {
    console.error('Password change error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
