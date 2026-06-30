/**
 * Audit Log API — TOUR-140
 * 
 * Admin-only endpoint for querying audit logs with filtering and pagination.
 * 
 * GET /api/audit-logs?entity_type=&actor_id=&event_type=&from=&to=&page=&limit=
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthInfo, requireAdmin } from '@/lib/rbac';
import { queryAuditLogs, type AuditLogQueryParams, AUDIT_EVENT_TYPES, type AuditEventType } from '@/lib/audit-log';

export async function GET(request: NextRequest) {
  try {
    // Require admin authentication — audit logs are sensitive
    const authInfo = await getAuthInfo(request);
    
    if (!authInfo) {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      );
    }

    // Admin-only access to audit logs
    if (authInfo.role !== 'admin') {
      return NextResponse.json(
        { 
          error: 'Admin access required for audit logs',
          currentRole: authInfo.role,
        },
        { status: 403 }
      );
    }

    // Parse query parameters
    const entityType = request.nextUrl.searchParams.get('entity_type') || undefined;
    const actorId = request.nextUrl.searchParams.get('actor_id') || undefined;
    const eventType = request.nextUrl.searchParams.get('event_type') || undefined;
    const fromParam = request.nextUrl.searchParams.get('from') || undefined;
    const toParam = request.nextUrl.searchParams.get('to') || undefined;
    const pageParam = parseInt(request.nextUrl.searchParams.get('page') || '1', 10);
    const limitParam = parseInt(request.nextUrl.searchParams.get('limit') || '20', 10);

    // Validate event_type if provided
    let validatedEventType: AuditEventType | undefined;
    if (eventType) {
      const validEventTypes = Object.values(AUDIT_EVENT_TYPES);
      if (!validEventTypes.includes(eventType as AuditEventType)) {
        return NextResponse.json(
          { 
            error: 'Invalid event_type',
            validEventTypes,
          },
          { status: 400 }
        );
      }
      validatedEventType = eventType as AuditEventType;
    }

    // Validate pagination parameters
    const page = Math.max(1, isNaN(pageParam) ? 1 : pageParam);
    const limit = Math.min(100, Math.max(1, isNaN(limitParam) ? 20 : limitParam));

    // Build query params object
    const queryParams: AuditLogQueryParams = {
      entityType,
      actorId,
      eventType: validatedEventType || undefined,
      from: fromParam,
      to: toParam,
      page,
      limit,
    };

    // Execute audit log query
    const result = await queryAuditLogs(queryParams);

    return NextResponse.json({
      logs: result.logs,
      pagination: {
        currentPage: result.pagination.page,
        totalPages: Math.ceil(result.pagination.total / result.pagination.limit) || 1,
        totalItems: result.pagination.total,
        itemsPerPage: result.pagination.limit,
        hasNextPage: result.pagination.hasNextPage,
        hasPrevPage: result.pagination.hasPrevPage,
      },
    });
  } catch (error) {
    console.error('Audit log query error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
