/**
 * Audit Log Middleware — TOUR-140 (Integration Layer)
 * 
 * Provides middleware functions that intercept key platform events
 * and automatically write audit log entries. These can be used as:
 * - Express-style middleware for route handlers
 * - Utility wrappers around event-triggering operations
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthInfo } from '@/lib/rbac';
import { 
  writeAuditLog, 
  logGoalCreated, 
  logTaskAssigned, 
  logUserRoleChanged,
  logAuthEvent,
  AUDIT_EVENT_TYPES,
} from '@/lib/audit-log';

// ============================================================================
// MIDDLEWARE FOR INTERCEPTING KEY EVENTS
// ============================================================================

/**
 * Middleware wrapper that logs authentication events.
 * Use this around login/logout route handlers to automatically capture auth events.
 */
export function auditAuthMiddleware(eventType: 'login_success' | 'login_failed' | 'logout') {
  return async (request: NextRequest, metadata?: Record<string, any>) => {
    const authInfo = await getAuthInfo(request);
    
    if (authInfo) {
      logAuthEvent(
        eventType, 
        authInfo.userId,
        { ...metadata, userEmail: authInfo.email }
      );
    } else if (eventType === 'login_failed') {
      // Log failed login attempts even without valid session
      writeAuditLog({
        eventType,
        entityType: 'user',
        metadata: { 
          reason: 'No valid session found',
          ...metadata,
        },
      });
    }
  };
}

/**
 * Middleware wrapper that logs user role changes.
 * Use this around admin role management endpoints.
 */
export function auditRoleChangeMiddleware(
  userId: string,
  actorId: string | null,
  oldRole: string,
  newRole: string
) {
  return async () => {
    if (actorId && oldRole !== newRole) {
      logUserRoleChanged(userId, actorId, oldRole as any, newRole as any);
    }
  };
}

// ============================================================================
// ROUTE HANDLER WRAPPERS FOR COMMON EVENTS
// ============================================================================

/**
 * Wrapper function for goal creation handlers.
 * Automatically logs the event after successful goal creation.
 */
export async function withGoalCreated(
  handler: () => Promise<NextResponse>,
  userId: string,
  goalId: string,
): Promise<NextResponse> {
  const response = await handler();
  
  // Log asynchronously (non-blocking)
  logGoalCreated(goalId, userId);
  
  return response;
}

/**
 * Wrapper function for task assignment changes.
 * Automatically logs the event with before/after assignee info.
 */
export async function withTaskAssigned(
  handler: () => Promise<NextResponse>,
  taskId: string,
  actorId: string,
  previousAssigneeId: string | null = null,
  newAssigneeId: string | null = null,
): Promise<NextResponse> {
  const response = await handler();
  
  // Log asynchronously (non-blocking)
  logTaskAssigned(taskId, newAssigneeId, previousAssigneeId, actorId);
  
  return response;
}

/**
 * Middleware that logs all incoming requests for admin users.
 * Useful for comprehensive audit trails in enterprise mode.
 */
export async function requestAuditMiddleware(request: NextRequest) {
  const authInfo = await getAuthInfo(request);
  
  if (authInfo && authInfo.role === 'admin') {
    writeAuditLog({
      eventType: AUDIT_EVENT_TYPES.GOAL_CREATED, // Generic event type for now
      actorId: authInfo.userId,
      entityType: 'request',
      metadata: {
        method: request.method,
        path: request.nextUrl.pathname,
        timestamp: new Date().toISOString(),
      },
    });
  }
}
