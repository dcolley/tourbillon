/**
 * Tourbillon Pagination Middleware — TOUR-146
 * 
 * Cursor-based pagination for Next.js API routes.
 * More efficient than offset-based for large datasets and concurrent modifications.
 */

import type { NextRequest } from 'next/server';

// ============================================================================
// PAGINATION TYPES
// ============================================================================

export interface PaginationParams {
  /** Maximum number of items per page (default: 20, max: 100) */
  limit?: number;
  /** Cursor for the next page — last item's ID from previous response */
  cursor?: string | null;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: PaginationInfo;
}

export interface PaginationInfo {
  hasMore: boolean;
  limit: number;
  cursor: string | null; // Next page cursor (null if last page)
  total?: number;       // Optional total count (expensive to compute, only include when needed)
}

// ============================================================================
// PAGINATION CONFIGURATION
// ============================================================================

export const PAGINATION_DEFAULTS = {
  defaultLimit: 20,
  maxLimit: 100,
  cursorField: 'id', // Default field used for cursor (usually UUID or numeric ID)
} as const;

// ============================================================================
// PARSING & VALIDATION
// ============================================================================

/**
 * Parse pagination parameters from a Next.js request.
 */
export function parsePaginationParams(request: NextRequest): PaginationParams {
  const searchParams = request.nextUrl.searchParams;
  
  const limitParam = searchParams.get('limit');
  const cursorParam = searchParams.get('cursor') || null;
  
  let limit = PAGINATION_DEFAULTS.defaultLimit;
  
  if (limitParam) {
    const parsed = parseInt(limitParam, 10);
    if (!isNaN(parsed)) {
      // Clamp to configured max
      limit = Math.min(Math.max(1, parsed), PAGINATION_DEFAULTS.maxLimit);
    }
  }

  return {
    limit: limit === PAGINATION_DEFAULTS.defaultLimit ? undefined : limit,
    cursor: cursorParam || null,
  };
}

/**
 * Validate and normalize pagination parameters.
 */
export function validatePagination(
  params: PaginationParams
): { valid: boolean; errors?: string[]; normalized: PaginationParams } {
  const errors: string[] = [];
  
  if (params.limit !== undefined && params.limit < 1) {
    errors.push('limit must be at least 1');
  }
  
  if (params.limit !== undefined && params.limit > PAGINATION_DEFAULTS.maxLimit) {
    errors.push(`limit cannot exceed ${PAGINATION_DEFAULTS.maxLimit}`);
  }

  return {
    valid: errors.length === 0,
    errors: errors.length > 0 ? errors : undefined,
    normalized: {
      limit: params.limit ?? PAGINATION_DEFAULTS.defaultLimit,
      cursor: params.cursor || null,
    },
  };
}

// ============================================================================
// CURSOR ENCODING/DECODING
// ============================================================================

/**
 * Encode a cursor value into a base64 string.
 * Format: {id}:{timestamp} (to handle ties and ensure ordering)
 */
export function encodeCursor(id: string | number, timestamp?: string): string {
  const cursorData = typeof id === 'string' ? `${id}:${timestamp || ''}` : `${String(id)}:${timestamp || new Date().toISOString()}`;
  return Buffer.from(cursorData).toString('base64');
}

/**
 * Decode a cursor back into its components.
 */
export function decodeCursor(cursor: string): { id: string | number; timestamp?: string } | null {
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf-8');
    const [id, timestamp] = decoded.split(':');
    
    if (!id) return null;
    
    // Try to parse as number
    const numericId = parseInt(id, 10);
    return {
      id: isNaN(numericId) ? id : numericId,
      timestamp: timestamp || undefined,
    };
  } catch {
    return null;
  }
}

// ============================================================================
// BUILDING PAGINATION RESPONSES
// ============================================================================

/**
 * Build a paginated response with proper headers.
 */
export function buildPaginatedResponse<T>(
  data: T[],
  params: PaginationParams,
  hasMore: boolean
): PaginatedResponse<T> {
  const limit = params.limit || PAGINATION_DEFAULTS.defaultLimit;
  
  return {
    data,
    pagination: {
      hasMore,
      limit,
      cursor: hasMore ? (params.cursor || null) : null, // Next page cursor would be set by caller
    },
  };
}

/**
 * Create a paginated response as JSON with proper headers.
 */
export function createPaginatedJsonResponse<T>(
  data: T[],
  params: PaginationParams,
  hasMore: boolean,
  nextCursor?: string | null
): Response {
  const limit = params.limit || PAGINATION_DEFAULTS.defaultLimit;

  const body: PaginatedResponse<T> = {
    data,
    pagination: {
      hasMore,
      limit,
      cursor: nextCursor !== undefined ? nextCursor : (hasMore ? encodeCursor(data[data.length - 1]) : null),
    },
  };

  return new Response(JSON.stringify(body), {
    headers: {
      'Content-Type': 'application/json',
      'X-Total-Pages': String(Math.ceil(data.length / limit) + (hasMore ? 1 : 0)),
      'X-Limit': String(limit),
      ...(nextCursor && !body.pagination.cursor ? {} : undefined), // Already in body
    },
  });
}

// ============================================================================
// DATABASE-AGNOSTIC PAGINATION HELPER
// ============================================================================

/**
 * Build query parameters for cursor-based pagination.
 * This can be used with both Prisma and Drizzle ORM.
 */
export function buildCursorQuery(cursor: string | null, field: string = 'id') {
  if (!cursor) return {}; // No cursor means start from beginning
  
  const decoded = decodeCursor(cursor);
  if (!decoded) return {};
  
  return {
    [field]: decoded.id, // For next-page queries (greater than cursor)
    order: {
      [field]: 'desc', // Descending order ensures consistent pagination
    },
  };
}

/**
 * Build a where clause for Drizzle ORM cursor pagination.
 */
export function buildDrizzleCursorWhere(cursorValue: string | number, field: string): any {
  return {
    [field]: { gt: cursorValue }, // Greater than cursor value
  };
}
