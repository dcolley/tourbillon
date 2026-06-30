/**
 * Goals List Endpoint — TOUR-146 (Pagination & Performance)
 * 
 * GET /api/goals?limit=20&cursor=<base64>&status=&priority=
 * Cursor-based pagination with performance tracking.
 */

import { NextRequest, NextResponse } from 'next/server';
import { eq, and, desc, gte, lte, ilike, count, sql } from 'drizzle-orm';
import { db, findUserByEmail } from '@tourbillon/db';
import { goals, tasks } from '@tourbillon/db/schema';
import { parsePaginationParams, encodeCursor, validatePagination, buildPaginatedResponse } from '@/lib/pagination';
import { createPerformanceTracker, trackPerformanceMetric } from '@/lib/performance';

// Performance target for goal list endpoints
const performance = createPerformanceTracker('goalList');

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
    const userId = searchParams.get('userId');
    const statusFilter = searchParams.get('status') || undefined;
    const priorityFilter = searchParams.get('priority') || undefined;
    const titleSearch = searchParams.get('search') || undefined;

    // Validate required params
    if (!userId) {
      return NextResponse.json(
        { error: 'userId query parameter is required' },
        { status: 400 }
      );
    }

    // Resolve user from email or ID
    let resolvedUserId = userId;
    if (userId && !userId.includes('-')) {
      const user = await findUserByEmail(userId);
      if (!user) {
        return NextResponse.json({ error: 'User not found' }, { status: 404 });
      }
      resolvedUserId = user.id;
    }

    // Build the cursor condition (if provided)
    const limit = validation.normalized.limit;
    const whereConditions = [eq(goals.userId, resolvedUserId)];
    
    if (statusFilter) {
      whereConditions.push(eq(goals.status, statusFilter));
    }
    if (priorityFilter) {
      whereConditions.push(eq(goals.priority, priorityFilter));
    }
    if (titleSearch) {
      whereConditions.push(ilike(goals.title, `%${titleSearch}%`));
    }

    // Apply cursor pagination
    let query = db.query.goals.findMany({
      where: and(...whereConditions),
      orderBy: desc(goals.createdAt),
      limit: limit + 1, // Fetch one extra to determine if there's a next page
    });

    if (validation.normalized.cursor) {
      const cursorId = validation.normalized.cursor;
      query = db.query.goals.findMany({
        where: and(
          ...whereConditions,
          lte(goals.createdAt, sql`to_timestamp((select extract(epoch from created_at) from goals where id = ${cursorId}))`) // Simplified for demonstration
        ),
        orderBy: desc(goals.createdAt),
        limit: limit + 1,
      });
    }

    const result = await performance(() => query);
    
    if (result.durationMs > PERFORMANCE_TARGETS.goalList.maxMs) {
      trackPerformanceMetric({
        endpoint: '/api/goals',
        method: 'GET',
        durationMs: result.durationMs,
        category: 'goalList',
      });
    }

    const goalList = result.result;
    const hasMore = goalList.length > limit;
    const data = hasMore ? goalList.slice(0, limit) : goalList;

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
        'X-Cache-Control': 'public, max-age=900', // Cache for 15 min (matches cache TTL)
        ...getTimingHeaders(Date.now() - startTime, 'goalList'),
      },
    });

  } catch (error: any) {
    console.error('Failed to fetch goals:', error);
    
    trackPerformanceMetric({
      endpoint: '/api/goals',
      method: 'GET',
      durationMs: Date.now() - startTime,
      category: 'goalList',
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
    goalList: { maxMs: 500 },
    default: { maxMs: 2000 },
  };
  
  return {
    'X-Response-Time': `${durationMs}ms`,
    'X-Performance-Target': targets[category]?.maxMs ? `${targets[category].maxMs}ms` : '2s',
  };
}
