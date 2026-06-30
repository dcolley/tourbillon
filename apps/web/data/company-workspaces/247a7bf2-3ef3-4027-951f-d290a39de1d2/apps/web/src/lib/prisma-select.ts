/**
 * Tourbillon Prisma Select Helpers — TOUR-146
 * 
 * Type-safe field selection helpers to avoid over-fetching from the database.
 * These ensure we only fetch the fields needed by each endpoint, reducing:
 * - Network payload size
 * - Database query complexity  
 * - Memory usage in Node.js
 */

import type { Prisma } from '@prisma/client';

// ============================================================================
// USER SELECTS
// ============================================================================

/**
 * Minimal user profile — used for API responses where full user data isn't needed.
 * Excludes passwordHash and sensitive fields.
 */
export const userProfileSelect = {
  id: true,
  email: true,
  name: true,
  role: true,
  provider: true,
  createdAt: true,
} as const satisfies Prisma.UserSelect;

/**
 * Full user profile — used for admin views and settings pages.
 * Includes all non-sensitive fields (passwordHash still excluded).
 */
export const userFullProfileSelect = {
  id: true,
  email: true,
  name: true,
  provider: true,
  role: true,
  mustResetPassword: true,
  passwordExpired: true,
  passwordChangedAt: true,
  createdAt: true,
} as const satisfies Prisma.UserSelect;

/**
 * User with relationships — used when user data is embedded in other responses.
 */
export const userProfileWithRelations = {
  ...userProfileSelect,
  goals: {
    select: {
      id: true,
      title: true,
      status: true,
    },
    take: 10, // Limit to recent goals
    orderBy: { createdAt: 'desc' },
  },
} as const satisfies Prisma.UserInclude;

// ============================================================================
// GOAL SELECTS
// ============================================================================

/**
 * Goal list item — used in goal listing pages.
 * Minimal fields for display purposes.
 */
export const goalListItemSelect = {
  id: true,
  title: true,
  status: true,
  priority: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.GoalSelect;

/**
 * Goal detail — used when viewing a single goal.
 */
export const goalDetailSelect = {
  id: true,
  title: true,
  description: true,
  status: true,
  priority: true,
  projectId: true,
  startDate: true,
  endDate: true,
  createdAt: true,
  updatedAt: true,
  user: {
    select: userProfileSelect,
  },
} as const satisfies Prisma.GoalInclude;

/**
 * Goal with tasks — used on goal detail page.
 */
export const goalWithTasksSelect = {
  ...goalDetailSelect,
  tasks: {
    select: {
      id: true,
      title: true,
      status: true,
      priority: true,
      orderIndex: true,
      assigneeId: true,
      dueDate: true,
    },
    orderBy: [
      { orderIndex: 'asc' },
      { createdAt: 'desc' },
    ],
  },
} as const satisfies Prisma.GoalInclude;

// ============================================================================
// TASK SELECTS
// ============================================================================

/**
 * Task list item — used in task listing pages.
 */
export const taskListItemSelect = {
  id: true,
  title: true,
  status: true,
  priority: true,
  orderIndex: true,
  dueDate: true,
} as const satisfies Prisma.TaskSelect;

/**
 * Task detail — used when viewing a single task.
 */
export const taskDetailSelect = {
  id: true,
  title: true,
  description: true,
  status: true,
  priority: true,
  orderIndex: true,
  dueDate: true,
  goalId: true,
  assigneeId: true,
  createdAt: true,
  updatedAt: true,
  goal: {
    select: {
      id: true,
      title: true,
      status: true,
    },
  },
} as const satisfies Prisma.TaskInclude;

/**
 * Task with assignee — used in task list views showing who's assigned.
 */
export const taskWithAssigneeSelect = {
  ...taskDetailSelect,
  assignee: {
    select: userProfileSelect,
  },
} as const satisfies Prisma.TaskInclude;

// ============================================================================
// PROJECT SELECTS
// ============================================================================

/**
 * Project list item — used in project listing pages.
 */
export const projectListItemSelect = {
  id: true,
  name: true,
  status: true,
  startDate: true,
  endDate: true,
} as const satisfies Prisma.ProjectSelect;

/**
 * Project detail — used when viewing a single project.
 */
export const projectDetailSelect = {
  ...projectListItemSelect,
  description: true,
  createdAt: true,
  updatedAt: true,
  goals: {
    select: {
      id: true,
      title: true,
      status: true,
    },
    orderBy: { priority: 'desc' },
  },
} as const satisfies Prisma.ProjectInclude;

// ============================================================================
// PAGINATION SELECT HELPER
// ============================================================================

/**
 * Generic pagination select builder.
 * Helps ensure paginated lists only fetch necessary fields.
 */
export function createPaginatedSelect<T extends Record<string, boolean>>(baseSelect: T): { 
  select: typeof baseSelect;
} {
  return {
    select: baseSelect,
  };
}

// ============================================================================
// USAGE EXAMPLES
// ============================================================================

/**
 * Example: Fetching goals with minimal overhead
 */
export async function fetchGoalsExample(prismaClient: any) {
  // ❌ BAD — fetching all fields including large text columns
  // const goals = await prisma.goal.findMany();
  
  // ✅ GOOD — only fetching displayable fields
  const goals = await prismaClient.goal.findMany({
    select: goalListItemSelect,
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
  
  return goals;
}

/**
 * Example: Fetching a single goal with related tasks
 */
export async function fetchGoalExample(prismaClient: any) {
  // ✅ GOOD — selecting only needed fields from each model
  const goal = await prismaClient.goal.findUnique({
    where: { id: 'goal-uuid-here' },
    select: goalWithTasksSelect,
  });
  
  return goal;
}

/**
 * Example: Fetching tasks with assignee info
 */
export async function fetchTasksExample(prismaClient: any) {
  const tasks = await prismaClient.task.findMany({
    where: { goalId: 'goal-uuid-here' },
    select: taskWithAssigneeSelect,
    orderBy: { orderIndex: 'asc' },
  });
  
  return tasks;
}
