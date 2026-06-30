/**
 * Tourbillon Database Seed Script
 * 
 * Creates sample data for development and testing purposes.
 * This script is idempotent — safe to run multiple times.
 * Run with: npx ts-node packages/db/src/seed.ts
 */

import { drizzle } from 'drizzle-orm/neon-serverless';
import bcryptjs from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { users, projects, goals, tasks, goalTasks } from './schema';

// ============================================================================
// CONFIGURATION
// ============================================================================
if (!process.env.DATABASE_URL) {
  console.error('❌ ERROR: DATABASE_URL environment variable is required');
  process.exit(1);
}

const SEED_PASSWORD = 'seed-password-123'; // For demo purposes only
const BCRYPT_SALT_ROUNDS = 10;

// ============================================================================
// SAMPLE DATA GENERATORS
// ============================================================================

async function generateSeedPassword(): Promise<string> {
  return bcryptjs.hash(SEED_PASSWORD, BCRYPT_SALT_ROUNDS);
}

function createUsersData(passwordHash: string) {
  return [
    // Admin user (CTO)
    {
      email: 'cto@tourbillon.io',
      passwordHash,
      name: 'Sarah Chen',
      provider: 'email',
      role: 'admin' as const,
      mustResetPassword: false,
      passwordExpired: false,
      passwordChangedAt: new Date(),
    },
    // Team lead
    {
      email: 'coo@tourbillon.io',
      passwordHash,
      name: 'Marcus Johnson',
      provider: 'email',
      role: 'member' as const,
      mustResetPassword: false,
      passwordExpired: false,
      passwordChangedAt: new Date(),
    },
    // Developer
    {
      email: 'engineer@tourbillon.io',
      passwordHash,
      name: 'Alex Rivera',
      provider: 'email',
      role: 'member' as const,
      mustResetPassword: false,
      passwordExpired: false,
      passwordChangedAt: new Date(),
    },
    // Viewer/Intern
    {
      email: 'intern@tourbillon.io',
      passwordHash,
      name: 'Jordan Kim',
      provider: 'email',
      role: 'viewer' as const,
      mustResetPassword: false,
      passwordExpired: false,
      passwordChangedAt: new Date(),
    },
  ];
}

async function createProjectsData(_db: ReturnType<typeof drizzle>, adminId: string) {
  return [
    {
      id: '11111111-1111-1111-1111-111111111111',
      name: 'Q3 Enterprise Readiness',
      description: 'Finalize security, onboarding polish, and platform scalability for the first 1000 users.',
      status: 'active',
      ownerId: adminId,
      startDate: new Date('2026-07-01'),
      endDate: new Date('2026-09-30'),
    },
    {
      id: '22222222-2222-2222-2222-222222222222',
      name: 'Developer Portal Launch',
      description: 'Build and launch the developer portal with API documentation, SDKs, and integration guides.',
      status: 'active',
      ownerId: adminId,
      startDate: new Date('2026-08-01'),
      endDate: new Date('2026-10-31'),
    },
    {
      id: '33333333-3333-3333-3333-333333333333',
      name: 'Community Growth Initiative',
      description: 'Scale community engagement through Discord, GitHub discussions, and user groups.',
      status: 'active',
      ownerId: adminId,
      startDate: new Date('2026-07-15'),
      endDate: new Date('2026-12-31'),
    },
  ];
}

async function createGoalsData(_db: ReturnType<typeof drizzle>, userIds: string[]) {
  const [adminId] = userIds;
  
  return [
    // Enterprise Readiness Goals
    {
      id: '44444444-4444-4444-4444-444444444444',
      userId: adminId,
      title: 'Database Migration to PostgreSQL',
      description: 'Migrate from SQLite/file-based storage to production-grade PostgreSQL with Drizzle ORM.',
      status: 'active',
      priority: 'high',
      projectId: '11111111-1111-1111-1111-111111111111',
      startDate: new Date('2026-07-01'),
      endDate: new Date('2026-07-31'),
    },
    {
      id: '55555555-5555-5555-5555-555555555555',
      userId: adminId,
      title: 'Authentication & Authorization Hardening',
      description: 'Implement RBAC, session management, and OAuth provider integration with proper security controls.',
      status: 'active',
      priority: 'high',
      projectId: '11111111-1111-1111-1111-111111111111',
      startDate: new Date('2026-07-01'),
      endDate: new Date('2026-08-15'),
    },
    {
      id: '66666666-6666-6666-6666-666666666666',
      userId: adminId,
      title: 'Performance Optimization for 1000 Users',
      description: 'Profile and optimize API response times to <200ms dashboard, <500ms goal list.',
      status: 'active',
      priority: 'medium',
      projectId: '11111111-1111-1111-1111-111111111111',
      startDate: new Date('2026-07-15'),
      endDate: new Date('2026-09-30'),
    },
    // Developer Portal Goals
    {
      id: '77777777-7777-7777-7777-777777777777',
      userId: adminId,
      title: 'API Documentation & SDK Release',
      description: 'Complete REST API documentation and release initial TypeScript SDK for community use.',
      status: 'active',
      priority: 'medium',
      projectId: '22222222-2222-2222-2222-222222222222',
      startDate: new Date('2026-08-01'),
      endDate: new Date('2026-09-30'),
    },
  ];
}

async function createTasksData(_db: ReturnType<typeof drizzle>, goalIds: string[]) {
  const [databaseGoalId, authGoalId, perfGoalId] = goalIds;
  
  return [
    // Database Migration Tasks
    {
      id: '88888888-8888-8888-8888-888888888888',
      goalId: databaseGoalId,
      title: 'Define Drizzle schema with User, Goal, Task, Project models',
      description: 'Create comprehensive database schema using Drizzle ORM PostgreSQL types.',
      status: 'done',
      priority: 'high',
      orderIndex: 1,
    },
    {
      id: '99999999-9999-9999-9999-999999999999',
      goalId: databaseGoalId,
      title: 'Create seed script with sample data',
      description: 'Implement idempotent seed script for development environment initialization.',
      status: 'in_progress',
      priority: 'high',
      orderIndex: 2,
    },
    {
      id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      goalId: databaseGoalId,
      title: 'Update connection strings and environment variables',
      description: 'Document Postgres URL configuration for production deployment.',
      status: 'todo',
      priority: 'medium',
      orderIndex: 3,
    },

    // Authentication Tasks
    {
      id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      goalId: authGoalId,
      title: 'Implement RBAC middleware for route protection',
      description: 'Create role-based access control layer that checks user permissions on API routes.',
      status: 'in_progress',
      priority: 'high',
      orderIndex: 1,
    },
    {
      id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      goalId: authGoalId,
      title: 'Add password policy enforcement (expiration & strength)',
      description: 'Enforce 90-day password expiration and minimum complexity requirements.',
      status: 'todo',
      priority: 'medium',
      orderIndex: 2,
    },

    // Performance Tasks
    {
      id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
      goalId: perfGoalId,
      title: 'Implement Redis caching layer for dashboard data',
      description: 'Add in-memory caching for frequently accessed resources with TTL-based expiration.',
      status: 'todo',
      priority: 'medium',
      orderIndex: 1,
    },
    {
      id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
      goalId: perfGoalId,
      title: 'Add pagination for goals and tasks lists',
      description: 'Implement cursor-based or offset pagination to handle large datasets efficiently.',
      status: 'todo',
      priority: 'medium',
      orderIndex: 2,
    },
  ];
}

async function createGoalTasksData(goalIds: string[]) {
  const [databaseGoalId] = goalIds;
  
  return [
    { goalId: databaseGoalId, taskId: '88888888-8888-8888-8888-888888888888' },
    { goalId: databaseGoalId, taskId: '99999999-9999-9999-9999-999999999999' },
    { goalId: databaseGoalId, taskId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' },
  ];
}

// ============================================================================
// SEED EXECUTION
// ============================================================================
async function seedDatabase() {
  console.log('🌱 Starting Tourbillon database seeding...\n');

  // Connect to database
  const db = drizzle(process.env.DATABASE_URL, { logger: process.env.NODE_ENV === 'development' });
  
  try {
    // Generate password hash for demo users
    const passwordHash = await generateSeedPassword();
    
    // Create users (skip existing)
    console.log('👤 Creating seed users...');
    const newUsers = createUsersData(passwordHash);
    
    let userIds: string[] = [];
    for (const userData of newUsers) {
      try {
        const result = await db.insert(users).values(userData).onConflictDoNothing().returning();
        if (result.length > 0) {
          console.log(`   ✅ Created user: ${userData.email}`);
          userIds.push(result[0].id as string);
        } else {
          // User exists, fetch their ID
          const existing = await db.query.users.findFirst({ where: (u, eq) => eq(u.email, userData.email) });
          if (existing) {
            console.log(`   ⏭️  Skipped (exists): ${userData.email}`);
            userIds.push(existing.id as string);
          }
        }
      } catch (error: any) {
        // Handle unique constraint violations gracefully
        if (error.code === '23505') { // Unique violation in PostgreSQL
          const existing = await db.query.users.findFirst({ where: (u, eq) => eq(u.email, userData.email) });
          if (existing) {
            console.log(`   ⏭️  Skipped (exists): ${userData.email}`);
            userIds.push(existing.id as string);
          }
        } else {
          throw error; // Re-throw other errors
        }
      }
    }

    if (userIds.length === 0) {
      console.log('   ⚠️  No users created or found.');
      return;
    }

    const [adminId] = userIds;

    // Create projects (skip existing)
    console.log('\n📁 Creating seed projects...');
    const projectDataList = await createProjectsData(db, adminId);
    
    for (const proj of projectDataList) {
      try {
        await db.insert(projects).values(proj).onConflictDoNothing().returning();
        console.log(`   ✅ Created project: ${proj.name}`);
      } catch (error: any) {
        if (error.code === '23505') {
          console.log(`   ⏭️  Skipped (exists): ${proj.name}`);
        } else {
          throw error;
        }
      }
    }

    // Create goals (skip existing)
    console.log('\n🎯 Creating seed goals...');
    const goalDataList = await createGoalsData(db, userIds);
    
    let goalIds: string[] = [];
    for (const goal of goalDataList) {
      try {
        const result = await db.insert(goals).values(goal).onConflictDoNothing().returning();
        if (result.length > 0) {
          console.log(`   ✅ Created goal: ${goal.title}`);
          goalIds.push(result[0].id as string);
        } else {
          const existing = await db.query.goals.findFirst({ where: (g, eq) => eq(g.id, goal.id) });
          if (existing) {
            console.log(`   ⏭️  Skipped (exists): ${goal.title}`);
            goalIds.push(existing.id as string);
          }
        }
      } catch (error: any) {
        // Handle unique constraints or other errors gracefully
        if (error.code === '23505' || error.code === '23514') {
          const existing = await db.query.goals.findFirst({ where: (g, eq) => eq(g.id, goal.id) });
          if (existing) {
            console.log(`   ⏭️  Skipped (exists): ${goal.title}`);
            goalIds.push(existing.id as string);
          }
        } else {
          throw error;
        }
      }
    }

    // Create tasks (skip existing)
    console.log('\n✅ Creating seed tasks...');
    const taskDataList = await createTasksData(db, goalIds);
    
    for (const task of taskDataList) {
      try {
        await db.insert(tasks).values(task).onConflictDoNothing().returning();
        console.log(`   ✅ Created task: ${task.title}`);
      } catch (error: any) {
        if (error.code === '23505') {
          console.log(`   ⏭️  Skipped (exists): ${task.title}`);
        } else {
          throw error;
        }
      }
    }

    // Create goal-task relationships
    console.log('\n🔗 Creating seed goal-task relationships...');
    const relationshipDataList = await createGoalTasksData(goalIds);
    
    for (const rel of relationshipDataList) {
      try {
        await db.insert(goalTasks).values(rel).onConflictDoNothing().returning();
        console.log(`   ✅ Linked task to goal`);
      } catch (error: any) {
        if (error.code === '23505') {
          console.log(`   ⏭️  Skipped (exists): ${rel.goalId} → ${rel.taskId}`);
        } else {
          throw error;
        }
      }
    }

    console.log('\n🌱 Database seeding completed successfully!');
    console.log('💡 Credentials: cto@tourbillon.io / seed-password-123');
    
  } catch (error: any) {
    console.error('\n❌ Seeding failed:', error.message);
    process.exit(1);
  }
}

// Run seeding
seedDatabase().catch(console.error);
