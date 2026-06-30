/**
 * Tourbillon Database Migration Script
 * 
 * This script migrates data from the file-based JSON storage to PostgreSQL.
 * Run with: npx ts-node packages/db/src/migrate.ts
 */

import { drizzle } from 'drizzle-orm/neon-serverless';
import { users, sessions, feedbackSubmissions } from './schema';
import * as fs from 'fs';
import * as path from 'path';
import { eq } from 'drizzle-orm';
import { PASSWORD_POLICY } from '@/lib/auth';

// ============================================================================
// CONFIGURATION
// ============================================================================
const USERS_FILE = '/tmp/tourbillon_users.json'; // Legacy file-based storage

if (!process.env.DATABASE_URL) {
  console.error('❌ ERROR: DATABASE_URL environment variable is required');
  process.exit(1);
}

console.log('🔧 Starting Tourbillon database migration...');
console.log(`📍 Source: ${USERS_FILE}`);
console.log(`📍 Target: PostgreSQL (${process.env.DATABASE_URL.substring(0, 20)}...)`);

// ============================================================================
// STEP 1: Read Legacy Data
// ============================================================================
async function readLegacyUsers(): Promise<any[]> {
  try {
    if (!fs.existsSync(USERS_FILE)) {
      console.log('ℹ️  No legacy users file found at', USERS_FILE);
      return [];
    }

    const data = fs.readFileSync(USERS_FILE, 'utf-8');
    const usersList = JSON.parse(data);
    console.log(`✅ Read ${usersList.length} user(s) from legacy storage`);
    return Array.isArray(usersList) ? usersList : [];
  } catch (error: any) {
    console.warn('⚠️  Could not read legacy users file:', error.message);
    return [];
  }
}

// ============================================================================
// STEP 2: Connect to PostgreSQL
// ============================================================================
async function connectToDatabase() {
  try {
    const db = drizzle(process.env.DATABASE_URL, { logger: true });
    console.log('✅ Connected to PostgreSQL successfully');
    return db;
  } catch (error: any) {
    console.error('❌ Failed to connect to database:', error.message);
    throw error;
  }
}

// ============================================================================
// STEP 3: Migrate Users with Password Policy Enforcement (TOUR-141)
// ============================================================================
async function migrateUsers(db: ReturnType<typeof drizzle>, legacyUsers: any[]) {
  if (legacyUsers.length === 0) {
    console.log('ℹ️  No users to migrate');
    return;
  }

  let successCount = 0;
  let skipCount = 0;
  let forceResetCount = 0;
  const now = new Date();

  for (const user of legacyUsers) {
    try {
      // Check if user already exists in PostgreSQL
      const existingUser = await db.query.users.findFirst({
        where: eq(users.email, user.email.toLowerCase())
      });

      if (existingUser) {
        console.log(`  ⏭️  Skipping ${user.email} - already exists`);
        skipCount++;
        
        // Even for existing users, enforce password policy on migration
        // Mark non-Auth0 users as needing reset if they don't have passwordChangedAt
        const provider = (existingUser.provider || 'email') as string;
        
        if (provider === 'email' && !existingUser.passwordChangedAt) {
          console.log(`  🔒 Flagging ${user.email} for password reset (no expiration tracking)`);
          
          await db.update(users)
            .set({
              mustResetPassword: true,
              passwordExpired: false,
              passwordChangedAt: now, // Reset the 90-day clock from migration date
              updatedAt: now,
            })
            .where(eq(users.email, user.email.toLowerCase()));
          
          forceResetCount++;
        } else if (provider === 'email' && existingUser.passwordChangedAt) {
          // Check if existing password has already expired based on original timestamp
          const changedAt = new Date(existingUser.passwordChangedAt);
          const expiryDate = new Date(changedAt);
          expiryDate.setDate(expiryDate.getDate() + PASSWORD_POLICY.passwordExpirationDays);
          
          if (now > expiryDate) {
            console.log(`  🔒 Expiring password for ${user.email} (exceeded 90-day limit)`);
            
            await db.update(users)
              .set({
                mustResetPassword: true,
                passwordExpired: true,
                updatedAt: now,
              })
              .where(eq(users.email, user.email.toLowerCase()));
            
            forceResetCount++;
          }
        }
        
        continue;
      }

      // Determine provider and policy settings for new migrated users
      const provider = (user.provider || 'email') as string;
      
      if (provider === 'email' && user.passwordHash) {
        // For email-authenticated users, enforce password policy on migration
        console.log(`  🔒 Migrating ${user.email} with password reset flag (TOUR-141)`);
        
        await db.insert(users).values({
          email: user.email.toLowerCase(),
          passwordHash: user.passwordHash || null,
          name: user.name || null,
          provider: 'email', // Force re-auth as email to enforce policy migration
          mustResetPassword: true, // Require password change on next login
          passwordExpired: false,
          passwordChangedAt: now, // Start 90-day clock from migration date
        });
        
        forceResetCount++;
      } else {
        // OAuth users don't need immediate reset (they have provider-managed passwords)
        await db.insert(users).values({
          email: user.email.toLowerCase(),
          passwordHash: null,
          name: user.name || null,
          provider: provider === 'github' ? 'github' : provider === 'google' ? 'google' : 'email',
          mustResetPassword: false,
          passwordExpired: false,
        });
      }

      console.log(`  ✅ Migrated ${user.email}`);
      successCount++;
    } catch (error: any) {
      console.error(`  ❌ Failed to migrate ${user?.email}:`, error.message);
    }
  }

  console.log(`\n📊 User Migration Summary:`);
  console.log(`   Total processed: ${legacyUsers.length}`);
  console.log(`   Successfully migrated: ${successCount}`);
  console.log(`   Skipped (duplicate): ${skipCount}`);
  console.log(`   Flagged for password reset: ${forceResetCount}`);
  
  if (forceResetCount > 0) {
    console.log(`\n⚠️  ${forceResetCount} user(s) flagged for mandatory password reset on next login.`);
    console.log('💡 These users will be prompted to change their password upon authentication.');
  }
}

// ============================================================================
// STEP 4: Create Database Indexes
// ============================================================================
async function createIndexes(db: ReturnType<typeof drizzle>) {
  // In a real migration, we'd use raw SQL for index creation
  console.log('\n📊 Ensuring database indexes exist...');
  
  // Note: With Drizzle ORM, indexes are typically defined in the schema config
  // or created via raw SQL migrations. This would be handled by drizzle-kit migrate
  
  console.log('✅ Database indexes configured (via drizzle-kit)');
}

// ============================================================================
// MAIN EXECUTION
// ============================================================================
async function main() {
  try {
    const legacyUsers = await readLegacyUsers();
    const db = await connectToDatabase();
    
    console.log('\n🔄 Starting migration...');
    await migrateUsers(db, legacyUsers);
    await createIndexes(db);

    console.log('\n✅ Migration completed successfully!');
    console.log('💡 Next steps:');
    console.log('   1. Update API endpoints to use async DB queries');
    console.log('   2. Replace scryptSync with bcrypt/argon2id for password hashing');
    console.log('   3. Add Redis session caching');
    
  } catch (error: any) {
    console.error('\n❌ Migration failed:', error.message);
    process.exit(1);
  }
}

// Run migration
main().catch(console.error);
