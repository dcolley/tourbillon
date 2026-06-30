/**
 * Tasks List Endpoint — TOUR-146 (Pagination & Performance)
 * 
 * GET /api/tasks?goalId=&limit=20&cursor=<base64>&status=todo
 * Cursor-based pagination with performance tracking.
 */

import { NextRequest, NextResponse } from 'next/server';
import { eq, and, desc, asc, sql } from 'drizzle-orm';
import { db } from '@tourbillon/db';
import { goals, tasks } from '@tourbillon/db/schema';
import { parsePaginationParams, encodeCursor, validatePagination } from '@/lib/pagination';
import { createPerformanceTracker, trackPerformanceMetric, getTimingHeaders } from '@/lib/performance';

// Performance target for task list endpoints
const performance = createPerformanceTracker('taskList');

export async function GET(request: NextRequest) {
  const startTime = Date.now();
  
  try {
    // Parse and validate pagination params
    const paginationParams = parsePaginationParams(request);
    const validation = validatePagination(paginationParams);
    
    if (!validation.valid && validation.errors) {
      return NextResponse.json(
        { error: 'Invalid pagination parameters', details: validation.errors },
        { status: 400 }
      );
    }

    // Extract query filters from URL
    const searchParams = request.nextUrl.searchParams;
    const goalId = searchParams.get('goalId');
    const statusFilter = searchParams.get('status') || undefined;
    const assigneeId = searchParams.get('assigneeId') || undefined;

    // Validate required params
    if (!goalId) {
      return NextResponse.json(
        { error: 'goalId query parameter is required' },
        { status: 400 }
      );
    }

    // Build the cursor condition (if provided)
    const limit = validation.normalized.limit;
    const whereConditions = [eq(tasks.goalId, goalId)];
    
    if (statusFilter) {
      whereConditions.push(eq(tasks.status, statusFilter));
    }
    if (assigneeId) {
      whereConditions.push(eq(tasks.assigneeId, assigneeId));
    }

    // Apply cursor pagination
    let query = db.query.tasks.findMany({
      where: and(...whereConditions),
      orderBy: [asc(tasks.orderIndex), desc(tasks.createdAt)],
      limit: limit + 1, // Fetch one extra to determine if there's a next page
    });

    if (validation.normalized.cursor) {
      const cursorId = validation.normalized.cursor;
      query = db.query.tasks.findMany({
        where: and(
          ...whereConditions,
          sql`id > ${cursorId}` // Simplified for demonstration
        ),
        orderBy: [asc(tasks.orderIndex), desc(tasks.createdAt)],
        limit: limit + 1,
      });
    }

    const result = await performance(() => query);
    
    if (result.durationMs > PERFORMANCE_TARGETS.taskList.maxMs) {
      trackPerformanceMetric({
        endpoint: '/api/tasks',
        method: 'GET',
        durationMs: result.durationMs,
        category: 'taskList',
      });
    }

    const taskList = result.result;
    const hasMore = taskList.length > limit;
    const data = hasMore ? taskList.slice(0, limit) : taskList;

    // Build next cursor if more results exist
    let nextCursor: string | null = null;
    if (hasMore && data.length > 0) {
      const lastItem = data[data.length - 1];
      nextCursor = encodeCursor(lastItem.id, lastItem.createdAt.toISOString());
    }

    // Build response with pagination info
    const response = buildPaginatedResponse(data, validation.normalized, hasMore);
    
    return NextResponse.json(response, {
      status: 200,
      headers: {
        'X-Total-Count': String(result.result.length),
        'X-Cache-Control': 'public, max-age=600', // Cache for 10 min (matches cache TTL)
        ...getTimingHeaders(Date.now() - startTime, 'taskList'),
      },
    });

  } catch (error: any) {
    console.error('Failed to fetch tasks:', error);
    
    trackPerformanceMetric({
      endpoint: '/api/tasks',
      method: 'GET',
      durationMs: Date.now() - startTime,
      category: 'taskList',
    });

    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

// Helper to get timing headers (inline for this file)
function getTimingHeaders(durationMs: number, category: string): Record<string, string> {
  const targets: Record<string, { maxMs: number }> = {
    taskList: { maxMs: 300 },
    default: { maxMs: 2000 },
  };
  
  return {
    'X-Response-Time': `${durationMs}ms`,
    'X-Performance-Target': targets[category]?.maxMs ? `${targets[category].maxMs}ms` : '2s',
  };
}
