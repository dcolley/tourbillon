/**
 * Shared authentication utilities.
 * Centralizes session token generation/verification and password hashing to eliminate duplication across auth routes.
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';

const SESSION_SECRET_FALLBACK = 'dev-session-secret-change-in-production';

// ============================================================================
// PASSWORD POLICY CONSTANTS (TOUR-141)
// ============================================================================
export const PASSWORD_POLICY = {
  minLength: 8,
  requireUppercase: true,
  requireLowercase: true,
  requireNumber: true,
  requireSpecialChar: true,
  specialChars: /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?~`]/,
  passwordExpirationDays: 90, // For non-Auth0 users
  reminderDaysBeforeExpiry: 14,
};

// ============================================================================
// SESSION TOKEN UTILITIES
// ============================================================================

export interface SessionPayload {
  userId: string;
  iat: number;
  provider?: string;
}

/**
 * Generate a signed session token (HMAC-SHA256) for a user.
 */
export function generateSessionToken(userId: string, provider = 'email'): string {
  const secret = process.env.SESSION_SECRET || SESSION_SECRET_FALLBACK;
  const payload = JSON.stringify({ userId, iat: Date.now(), provider });
  const hmac = require('crypto').createHmac('sha256', secret);
  hmac.update(payload);
  return `${payload}.${hmac.digest('hex')}`;
}

/**
 * Verify a session token and extract the payload.
 * Returns null if invalid, expired (>1 week), or malformed.
 */
export function verifySessionToken(token: string): SessionPayload | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [payloadStr, signature] = parts;
  const secret = process.env.SESSION_SECRET || SESSION_SECRET_FALLBACK;

  try {
    const payload: SessionPayload = JSON.parse(payloadStr);

    // Verify HMAC signature
    const hmac = require('crypto').createHmac('sha256', secret);
    const expectedSignature = hmac.update(payloadStr).digest('hex');
    if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
      return null;
    }

    // Check token age (1 week max, same as cookie expiry)
    if (payload.iat && Date.now() - payload.iat > 7 * 24 * 60 * 60 * 1000) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

/**
 * Hash a password using scrypt (same algorithm as the old file-based system for compatibility).
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

/**
 * Verify a password against a stored hash (scrypt format: "salt:hash").
 */
export function verifyPassword(password: string, storedHash: string): boolean {
  const [salt, hash] = storedHash.split(':');
  if (!salt || !hash) return false;

  try {
    const derivedKey = scryptSync(password, salt, 64);
    const storedKey = Buffer.from(hash, 'hex');
    return timingSafeEqual(derivedKey, storedKey);
  } catch {
    return false;
  }
}

/**
 * Validate email format.
 */
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ============================================================================
// PASSWORD POLICY VALIDATION (TOUR-141)
// ============================================================================

/**
 * Check if password meets the minimum requirements.
 */
export function validatePasswordPolicy(password: string): {
  valid: boolean;
  errors: string[];
  score: number; // 0-100
} {
  const errors: string[] = [];
  let score = 0;

  // Length check (weight: 25 points)
  if (password.length >= PASSWORD_POLICY.minLength) {
    score += 25;
  } else {
    errors.push(`Password must be at least ${PASSWORD_POLICY.minLength} characters long`);
  }

  // Uppercase check (weight: 15 points)
  if (/[A-Z]/.test(password)) {
    score += 15;
  } else if (PASSWORD_POLICY.requireUppercase) {
    errors.push('Password must contain at least one uppercase letter');
  }

  // Lowercase check (weight: 15 points)
  if (/[a-z]/.test(password)) {
    score += 15;
  } else if (PASSWORD_POLICY.requireLowercase) {
    errors.push('Password must contain at least one lowercase letter');
  }

  // Number check (weight: 20 points)
  if (/\d/.test(password)) {
    score += 20;
  } else if (PASSWORD_POLICY.requireNumber) {
    errors.push('Password must contain at least one number');
  }

  // Special character check (weight: 25 points)
  if (PASSWORD_POLICY.specialChars.test(password)) {
    score += 25;
  } else if (PASSWORD_POLICY.requireSpecialChar) {
    errors.push('Password must contain at least one special character (!@#$%^&* etc.)');
  }

  // Bonus for longer passwords (>12 chars)
  if (password.length > 12) score += 5;

  return {
    valid: errors.length === 0,
    errors,
    score,
  };
}

/**
 * Get a human-readable password strength label.
 */
export function getPasswordStrengthLabel(score: number): 'weak' | 'fair' | 'good' | 'strong' {
  if (score >= 85) return 'strong';
  if (score >= 70) return 'good';
  if (score >= 50) return 'fair';
  return 'weak';
}

/**
 * Check if a password has expired based on the last changed date.
 */
export function isPasswordExpired(passwordChangedAt: Date | null, expirationDays = PASSWORD_POLICY.passwordExpirationDays): boolean {
  if (!passwordChangedAt) return false;
  const expiryDate = new Date(passwordChangedAt);
  expiryDate.setDate(expiryDate.getDate() + expirationDays);
  return new Date() > expiryDate;
}

/**
 * Check if a password is approaching expiration (within reminder days).
 */
export function isPasswordExpiringSoon(passwordChangedAt: Date, reminderDays = PASSWORD_POLICY.reminderDaysBeforeExpiry): boolean {
  const expiryDate = new Date(passwordChangedAt);
  expiryDate.setDate(expiryDate.getDate() + PASSWORD_POLICY.passwordExpirationDays);
  const reminderThreshold = new Date();
  reminderThreshold.setDate(reminderThreshold.getDate() + reminderDays);
  return expiryDate <= reminderThreshold && !isPasswordExpired(passwordChangedAt);
}
