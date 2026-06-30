/**
 * Role-Based Access Control (RBAC) Utilities — TOUR-139
 * 
 * Provides role checking, permission validation, and middleware for protected routes.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifySessionToken, SessionPayload } from './auth';
import { db, users } from '@tourbillon/db';
import { eq } from 'drizzle-orm';

// ============================================================================
// ROLE CONSTANTS & PERMISSIONS
// ============================================================================

export type UserRole = 'admin' | 'member' | 'viewer';

export const ROLES: readonly UserRole[] = ['admin', 'member', 'viewer'] as const;

/** Role hierarchy — higher number = more privileges */
export const ROLE_HIERARCHY: Record<UserRole, number> = {
  viewer: 1,
  member: 2,
  admin: 3,
};

// Permission matrix for each role
export const PERMISSIONS: Record<UserRole, string[]> = {
  // Admin: full CRUD access to everything
  admin: [
    'user:create',
    'user:read',
    'user:update',
    'user:delete',
    'role:manage',       // Can assign/change roles of other users
    'project:create',
    'project:read',
    'project:update',
    'project:delete',
    'goal:create',
    'goal:read',
    'goal:update',
    'goal:delete',
    'task:create',
    'task:read',
    'task:update',
    'task:delete',
    'agent:configure',   // Configure AI agents, custom prompts
    'integration:manage',  // Manage all integrations
    'settings:admin',    // Admin-level settings (billing, security)
    'webhook:create',
    'webhook:read',
    'webhook:update',
    'webhook:delete',
    'api_key:create',
    'api_key:read',
    'api_key:revoke',
    'rate_limit:view',
    'nps:view',          // View NPS survey responses
    'feedback:view',     // View all feedback submissions
  ],

  // Member: ReadWrite access to projects, goals, tasks (but not user/role management)
  member: [
    'project:create',
    'project:read',
    'project:update',
    'goal:create',
    'goal:read',
    'goal:update',
    'task:create',
    'task:read',
    'task:update',
    'agent:use',         // Can use agents but not configure custom prompts
    'integration:view',  // View own integrations, connect new ones
    'settings:user',     // User-level settings only (profile, notifications)
    'webhook:create',    // Create webhooks for their projects
    'webhook:read',
    'webhook:update',
    'webhook:delete',
    'api_key:create',
    'api_key:read',
    'rate_limit:view',
  ],

  // Viewer: Read-only access to shared content
  viewer: [
    'project:read',
    'goal:read',
    'task:read',
    'agent:view',        // Can view agent activity but not interact
    'integration:view',  // View integrations only (no connect/disconnect)
    'settings:user',     // User-level settings only
    'webhook:read',      // Read-only access to webhooks
    'api_key:read',      // Can view own API keys
    'rate_limit:view',   // Can view rate limit status
  ],
};

/** Check if a role has permission to perform an action */
export function hasPermission(role: UserRole, permission: string): boolean {
  const rolePermissions = PERMISSIONS[role];
  return rolePermissions.includes(permission) || rolePermissions.includes('*');
}

/** Check if a user's role meets the minimum required role for a resource or action */
export function meetsMinimumRole(userRole: UserRole, minRequiredRole: UserRole): boolean {
  return ROLE_HIERARCHY[userRole] >= ROLE_HIERARCHY[minRequiredRole];
}

// ============================================================================
// AUTH MIDDLEWARE
// ============================================================================

/**
 * Interface for session info extracted by middleware.
 */
export interface AuthInfo {
  userId: string;
  email: string;
  name?: string | null;
  role: UserRole;
  provider?: string | null;
}

/**
 * Extract authenticated user info from the request.
 * Returns null if not authenticated.
 */
export async function getAuthInfo(request: NextRequest): Promise<AuthInfo | null> {
  const sessionCookie = request.cookies.get('session')?.value;
  
  if (!sessionCookie) return null;

  const payload = verifySessionToken(sessionCookie);
  
  if (!payload) return null;

  // Fetch user from database with role info
  try {
    const user = await db.query.users.findFirst({
      where: eq(users.id, payload.userId),
      columns: {
        email: true,
        name: true,
        provider: true,
        role: true,
      },
    });

    if (!user) return null;

    return {
      userId: payload.userId,
      email: user.email,
      name: user.name || undefined,
      role: (user.role as UserRole) || 'member', // Default to member if not set
      provider: user.provider || undefined,
    };
  } catch (error) {
    console.error('RBAC middleware error fetching user:', error);
    return null;
  }
}

/**
 * Create a middleware function that enforces role-based access on protected routes.
 * 
 * @param minRole - Minimum required role for the route ('admin', 'member', or 'viewer')
 * @returns A middleware handler function
 */
export function requireRole(minRole: UserRole = 'member') {
  return async (request: NextRequest): Promise<NextResponse | null> => {
    const authInfo = await getAuthInfo(request);

    if (!authInfo) {
      // Not authenticated — redirect to login or return 401
      const redirectTo = `${process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'}/auth/login?redirect=${encodeURIComponent(request.url)}`;
      return NextResponse.redirect(redirectTo);
    }

    if (!meetsMinimumRole(authInfo.role, minRole)) {
      console.warn(`Access denied for user ${authInfo.email} (${authInfo.role}). Required: ${minRole}`);
      
      // Return 403 Forbidden with helpful error message
      return NextResponse.json(
        { 
          error: 'Insufficient permissions',
          requiredRole: minRole,
          currentRole: authInfo.role,
          message: `You need the "${minRole}" role to access this resource. Contact an administrator for assistance.`
        },
        { status: 403 }
      );
    }

    // Authenticated and authorized — attach user info to request context
    (request as NextRequest & { authInfo?: AuthInfo }).authInfo = authInfo;
    return null; // Continue to route handler
  };
}

/**
 * Middleware that requires admin role specifically.
 */
export function requireAdmin(request: NextRequest): Promise<NextResponse | null> {
  return requireRole('admin')(request);
}

/**
 * Middleware that requires member or higher (member, admin).
 */
export function requireMemberOrHigher(request: NextRequest): Promise<NextResponse | null> {
  return requireRole('member')(request);
}
