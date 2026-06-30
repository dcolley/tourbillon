/**
 * Tourbillon Database Seed Script (Prisma) — TOUR-144
 * 
 * Creates sample data for development and testing purposes.
 * This script is idempotent — safe to run multiple times.
 * Run with: npx prisma db seed
 */

import { PrismaClient, UserRole } from '@prisma/client';

const prisma = new PrismaClient();

// ============================================================================
// CONFIGURATION
// ============================================================================
if (!process.env.DATABASE_URL) {
  console.error('❌ ERROR: DATABASE_URL environment variable is required');
  process.exit(1);
}

const SEED_PASSWORD = 'seed-password-123'; // For demo purposes only
const BCRYPT_SALT_ROUNDS = 10;

// Simple hash function for seed data (in production, use bcrypt properly)
async function generateSeedPassword(): Promise<string> {
  const bcrypt = await import('bcryptjs');
  return bcrypt.default.hash(SEED_PASSWORD, BCRYPT_SALT_ROUNDS);
}

// ============================================================================
// SAMPLE DATA GENERATORS
// ============================================================================

async function createUsers(passwordHash: string) {
  const users = [
    // Admin user (CTO)
    {
      email: 'cto@tourbillon.io',
      passwordHash,
      name: 'Sarah Chen',
      provider: 'email',
      role: UserRole.admin,
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
      role: UserRole.member,
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
      role: UserRole.member,
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
      role: UserRole.viewer,
      mustResetPassword: false,
      passwordExpired: false,
      passwordChangedAt: new Date(),
    },
  ];

  for (const userData of users) {
    await prisma.user.upsert({
      where: { email: userData.email.toLowerCase() },
      update: {},
      create: userData,
    });
    console.log(`   ✅ User: ${userData.email}`);
  }

  return users;
}

async function createProjects(adminId: string) {
  const projects = [
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

  for (const proj of projects) {
    await prisma.project.upsert({
      where: { id: proj.id },
      update: {},
      create: proj,
    });
    console.log(`   ✅ Project: ${proj.name}`);
  }

  return projects;
}

async function createGoals(userIds: string[]) {
  const adminId = userIds[0];
  
  const goals = [
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
  ];

  for (const goal of goals) {
    await prisma.goal.upsert({
      where: { id: goal.id },
      update: {},
      create: goal,
    });
    console.log(`   ✅ Goal: ${goal.title}`);
  }

  return goals;
}

async function createTasks(goalIds: string[]) {
  const [databaseGoalId, authGoalId, perfGoalId] = goalIds;
  
  const tasks = [
    // Database Migration Tasks
    {
      id: '88888888-8888-8888-8888-888888888888',
      goalId: databaseGoalId,
      title: 'Define Prisma schema with User, Goal, Task, Project models',
      description: 'Create comprehensive database schema using Prisma ORM PostgreSQL types.',
      status: 'done',
      priority: 'high',
      orderIndex: 1,
    },
    {
      id: '99999999-9999-9999-9999-999999999999',
      goalId: databaseGoalId,
      title: 'Create seed script with sample data',
      description: 'Implement idempotent seed script for development environment initialization.',
      status: 'done',
      priority: 'high',
      orderIndex: 2,
    },
    {
      id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      goalId: databaseGoalId,
      title: 'Update connection strings and environment variables',
      description: 'Document Postgres URL configuration for production deployment.',
      status: 'done',
      priority: 'medium',
      orderIndex: 3,
    },

    // Authentication Tasks
    {
      id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      goalId: authGoalId,
      title: 'Implement RBAC middleware for route protection',
      description: 'Create role-based access control layer that checks user permissions on API routes.',
      status: 'done',
      priority: 'high',
      orderIndex: 1,
    },
    {
      id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      goalId: authGoalId,
      title: 'Add password policy enforcement (expiration & strength)',
      description: 'Enforce 90-day password expiration and minimum complexity requirements.',
      status: 'done',
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

  for (const task of tasks) {
    await prisma.task.upsert({
      where: { id: task.id },
      update: {},
      create: task,
    });
    console.log(`   ✅ Task: ${task.title}`);
  }

  return tasks;
}

// ============================================================================
// SEED EXECUTION
// ============================================================================
async function seedDatabase() {
  console.log('🌱 Starting Tourbillon database seeding (Prisma)...\\n');

  try {
    // Generate password hash for demo users
    const passwordHash = await generateSeedPassword();
    
    // Create users
    console.log('👤 Creating seed users...');
    const users = await createUsers(passwordHash);
    
    // Get admin ID
    const adminId = users[0].id;

    // Create projects
    console.log('\\n📁 Creating seed projects...');
    await createProjects(adminId);

    // Create goals
    console.log('\\n🎯 Creating seed goals...');
    const userids = users.map(u => u.id);
    const goals = await createGoals(userids);
    
    // Create tasks
    console.log('\\n✅ Creating seed tasks...');
    const goalIds = goals.map(g => g.id);
    await createTasks(goalIds);

    console.log('\\n🌱 Database seeding completed successfully!');
    console.log('💡 Credentials: cto@tourbillon.io / seed-password-123');
    
  } catch (error) {
    console.error('\\n❌ Seeding failed:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

// Run seeding
seedDatabase().catch(console.error);
