/**
 * User Role Management API — TOUR-139 (RBAC)
 * 
 * Admin-only endpoints for managing user roles.
 * 
 * Usage patterns:
 * - GET  /api/auth/users/roles              — List all users with their roles (admin only)
 * - GET  /api/auth/user?email=xxx           — Get a specific user's role info
 * - PUT  /api/auth/user-role                — Assign/update a user's role (body: { email, role })
 * - GET  /api/auth/roles                    — List all available roles and their permissions
 */

import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, users } from '@tourbillon/db';
import { getAuthInfo, hasPermission, ROLE_HIERARCHY, type UserRole, ROLES, PERMISSIONS } from '@/lib/rbac';

// ============================================================================
// GET /api/auth/roles — List all available roles and their permissions (TOUR-139)
// ============================================================================

export async function GET(request: NextRequest) {
  try {
    const authInfo = await getAuthInfo(request);
    
    if (!authInfo) {
      // Only return role names to unauthenticated users
      return NextResponse.json({ roles: ROLES.map(r => ({ name: r })) });
    }

    // Members and admins can see full role definitions with permissions
    const roleDefinitions = ROLES.map(role => ({
      name: role,
      level: ROLE_HIERARCHY[role],
      description: getRoleDescription(role),
      permissions: PERMISSIONS[role] || [],
      permissionCount: (PERMISSIONS[role] || []).length,
    }));

    return NextResponse.json({ roles: roleDefinitions });
  } catch (error) {
    console.error('List roles error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

// ============================================================================
// PUT /api/auth/user-role — Assign/update a user's role (admin only)
// ============================================================================

export async function POST(request: NextRequest) {
  try {
    // Require admin authentication — privileged operation
    const authInfo = await getAuthInfo(request);
    
    if (!authInfo || ROLE_HIERARCHY[authInfo.role] < ROLE_HIERARCHY['admin']) {
      return NextResponse.json(
        { error: 'Admin access required to manage user roles.' },
        { status: 403 }
      );
    }

    const body = await request.json();
    
    // Validate input
    if (!body.email || !body.role) {
      return NextResponse.json(
        { error: 'Email and role are required' },
        { status: 400 }
      );
    }

    // Validate role value
    const newRole: UserRole = body.role;
    
    if (!ROLES.includes(newRole)) {
      return NextResponse.json(
        { error: 'Invalid role. Must be one of:', validRoles: ROLES },
        { status: 400 }
      );
    }

    // Prevent self-administration (security measure)
    if (authInfo.email.toLowerCase() === body.email.toLowerCase() && newRole === 'admin') {
      return NextResponse.json(
        { error: 'Self-administration is not allowed. Contact the system administrator.' },
        { status: 403 }
      );
    }

    // Prevent self-downgrade (maintain at least current role level)
    if (authInfo.email.toLowerCase() === body.email.toLowerCase()) {
      const userRoleLevel = ROLE_HIERARCHY[authInfo.role];
      if (ROLE_HIERARCHY[newRole] < userRoleLevel) {
        return NextResponse.json(
          { error: `Cannot downgrade to a lower role. Your minimum role is '${authInfo.role}'.` },
          { status: 403 }
        );
      }
    }

    // Find the target user by email
    const targetUser = await db.query.users.findFirst({
      where: eq(users.email, body.email.toLowerCase()),
    });

    if (!targetUser) {
      return NextResponse.json(
        { error: 'User not found' },
        { status: 404 }
      );
    }

    const previousRole = targetUser.role as UserRole;

    // Check for no-op (same role)
    if (previousRole === newRole) {
      return NextResponse.json({
        message: `User is already assigned '${newRole}' role. No changes made.`,
        id: targetUser.id,
        email: targetUser.email,
        previousRole,
        currentRole: newRole,
      });
    }

    // Update the user's role in database
    const updatedUsers = await db.update(users)
      .set({ 
        role: newRole,
        updatedAt: new Date(),
      })
      .where(eq(users.email, body.email.toLowerCase()))
      .returning({ id: users.id, email: users.email, role: users.role });

    if (!updatedUsers || updatedUsers.length === 0) {
      return NextResponse.json(
        { error: 'Failed to update user role' },
        { status: 500 }
      );
    }

    // Log the role change for audit purposes (TOUR-140 integration point)
    console.log(`[RBAC] Role changed: ${authInfo.email} (${authInfo.role}) → ${newRole} [target: ${body.email}, previous: ${previousRole}]`);

    return NextResponse.json({
      message: `User role updated from '${previousRole}' to '${newRole}'.`,
      id: updatedUsers[0].id,
      email: updatedUsers[0].email,
      previousRole,
      currentRole: newRole as UserRole,
      permissions: PERMISSIONS[newRole] || [],
    });
  } catch (error) {
    console.error('Update user role error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

// ============================================================================
// GET /api/auth/users/roles — List all users with their roles (admin only)
// ============================================================================

export async function _listUsersWithRoles(request: NextRequest) {
  try {
    const authInfo = await getAuthInfo(request);
    
    if (!authInfo || ROLE_HIERARCHY[authInfo.role] < ROLE_HIERARCHY['admin']) {
      return NextResponse.json(
        { error: 'Admin access required to list users with roles.' },
        { status: 403 }
      );
    }

    // Fetch all users (excluding password hashes)
    const allUsers = await db.query.users.findMany({
      columns: {
        id: true,
        email: true,
        name: true,
        provider: true,
        role: true,
        createdAt: true,
      },
      orderBy: (users, { desc }) => [desc(users.createdAt)],
    });

    return NextResponse.json({
      users: allUsers.map(u => ({
        id: u.id,
        email: u.email,
        name: u.name || null,
        provider: u.provider || 'email',
        role: u.role as UserRole,
        createdAt: u.createdAt,
      })),
      total: allUsers.length,
    });
  } catch (error) {
    console.error('List users with roles error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

// ============================================================================
// HELPERS
// ============================================================================

function getRoleDescription(role: UserRole): string {
  switch (role) {
    case 'admin':
      return 'Full access to all features, including user management and role assignment.';
    case 'member':
      return 'Can create and edit projects, goals, and tasks. Cannot manage users or roles.';
    case 'viewer':
      return 'Read-only access to shared projects, goals, and tasks. Cannot create or modify content.';
    default:
      return '';
  }
}
