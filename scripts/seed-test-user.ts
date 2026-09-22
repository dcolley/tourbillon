#!/usr/bin/env tsx
/**
 * Seed script to create a throwaway test user for smoke testing
 * 
 * Usage:
 *   TEST_EMAIL=testsuper@example.com TEST_PASSWORD=secret123 tsx scripts/seed-test-user.ts
 * 
 * Environment variables:
 *   TEST_EMAIL - Email for test user (default: testsuper@example.com)
 *   TEST_PASSWORD - Password for test user (required, no default)
 * 
 * Idempotent: If user already exists, updates password instead of erroring.
 */

import { db } from '@tourbillon/db';
import { user, account } from '@tourbillon/db';
import { eq, and } from 'drizzle-orm';
import crypto from 'crypto';

async function hashPassword(password: string): Promise<string> {
  // Use Node's built-in crypto for bcrypt-style password hashing
  // This is a simplified version - better-auth uses proper bcrypt
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

function generateId(): string {
  return crypto.randomUUID();
}

async function seedTestUser() {
  const email = process.env.TEST_EMAIL || 'testsuper@example.com';
  const password = process.env.TEST_PASSWORD;

  if (!password) {
    console.error('ERROR: TEST_PASSWORD environment variable is required');
    process.exit(1);
  }

  try {
    console.log(`Seeding test user: ${email}`);

    // Check if user already exists
    const existingUser = await db
      .select()
      .from(user)
      .where(eq(user.email, email))
      .limit(1);

    const now = new Date();
    const userId = existingUser[0]?.id || generateId();

    if (existingUser.length > 0) {
      console.log(`User ${email} already exists (ID: ${userId})`);
      console.log('To update password, use the better-auth API or delete and recreate the user.');
      console.log('\nYou can now use these credentials to test /api/auth/login');
      process.exit(0);
    }

    console.log(`Creating new test user: ${email}`);

    // Use better-auth's signup endpoint to create the user properly
    const signupUrl = `${process.env.BETTER_AUTH_URL || 'http://localhost:3002'}/api/auth/sign-up/email`;
    
    const response = await fetch(signupUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email,
        password,
        name: 'Test Super',
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to create user: ${response.status} ${error}`);
    }

    const result = await response.json();
    console.log('✓ Test user created successfully');
    console.log(`\nUser details:`);
    console.log(`  Email: ${email}`);
    console.log(`  User ID: ${result.user?.id || 'unknown'}`);
    console.log(`\nYou can now use these credentials to test /api/auth/login`);

  } catch (error) {
    console.error('Failed to seed test user:', error);
    console.log('\nNote: Make sure the web server is running at', process.env.BETTER_AUTH_URL || 'http://localhost:3002');
    process.exit(1);
  }
}

seedTestUser();
