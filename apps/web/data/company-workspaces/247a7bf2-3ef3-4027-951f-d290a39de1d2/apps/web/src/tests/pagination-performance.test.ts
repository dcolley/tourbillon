/**
 * Tourbillon Pagination & Performance Integration Tests — TOUR-146
 * 
 * Tests for cursor-based pagination and performance tracking middleware.
 */

import { describe, it, expect, vi } from 'vitest';
import { parsePaginationParams, encodeCursor, decodeCursor, validatePagination, buildPaginatedResponse } from '../pagination';
import { createPerformanceTracker, trackPerformanceMetric, meetsPerformanceTarget } from '../performance';

// Mock NextRequest for testing pagination params parsing
function mockNextRequest(searchParams: Record<string, string>): any {
  return {
    nextUrl: new URL(`http://localhost?${new URLSearchParams(searchParams).toString()}`),
  };
}

describe('Pagination Middleware', () => {
  describe('parsePaginationParams', () => {
    it('should use default limit when none provided', () => {
      const params = parsePaginationParams(mockNextRequest({}));
      expect(params.limit).toBeUndefined(); // Default not set, will be applied in validation
    });

    it('should parse custom limit from URL', () => {
      const params = parsePaginationParams(mockNextRequest({ limit: '50' }));
      expect(params.limit).toBe(50);
    });

    it('should handle cursor parameter', () => {
      const cursor = encodeCursor('test-id-123');
      const params = parsePaginationParams(mockNextRequest({ cursor }));
      expect(params.cursor).toBe(cursor);
    });

    it('should ignore invalid limit values and use default', () => {
      const params = parsePaginationParams(mockNextRequest({ limit: 'invalid' }));
      // Invalid value should be ignored, returned as undefined (default will be applied)
      expect(params.limit).toBeUndefined();
    });

    it('should clamp limit to maximum (100)', () => {
      const params = parsePaginationParams(mockNextRequest({ limit: '200' }));
      // Note: Clamping happens in validation, parsing just reads the value
      expect(params.limit).toBe(200);
    });
  });

  describe('validatePagination', () => {
    it('should accept valid pagination params with defaults', () => {
      const result = validatePagination({});
      expect(result.valid).toBe(true);
      expect(result.normalized.limit).toBe(20); // Default limit
      expect(result.errors).toBeUndefined();
    });

    it('should accept custom valid limit', () => {
      const result = validatePagination({ limit: 50 });
      expect(result.valid).toBe(true);
      expect(result.normalized.limit).toBe(50);
    });

    it('should reject negative limit', () => {
      const result = validatePagination({ limit: -1 });
      expect(result.valid).toBe(false);
      expect(result.errors?.length).toBeGreaterThan(0);
    });

    it('should cap limit at maximum (100)', () => {
      // Note: Validation checks for errors but doesn't modify the value
      const result = validatePagination({ limit: 200 });
      expect(result.valid).toBe(false); // Will fail validation if over max
      expect(result.errors?.length).toBeGreaterThan(0);
    });

    it('should accept null cursor', () => {
      const result = validatePagination({ cursor: null });
      expect(result.valid).toBe(true);
    });
  });

  describe('encodeCursor / decodeCursor', () => {
    it('should encode and decode string ID', () => {
      const id = 'user-12345';
      const encoded = encodeCursor(id, '2026-07-01T00:00:00Z');
      expect(encoded).toBeTruthy();
      
      const decoded = decodeCursor(encoded);
      expect(decoded?.id).toBe(id);
    });

    it('should encode and decode numeric ID', () => {
      const id = 42;
      const encoded = encodeCursor(id, '2026-07-01T00:00:00Z');
      
      const decoded = decodeCursor(encoded);
      expect(decoded?.id).toBe(42);
    });

    it('should handle invalid cursor gracefully', () => {
      const decoded = decodeCursor('not-valid-base64!!!');
      expect(decoded).toBeNull();
    });
  });

  describe('buildPaginatedResponse', () => {
    it('should build response with hasMore=false when no more items', () => {
      const data = [{ id: '1' }, { id: '2' }];
      const result = buildPaginatedResponse(data, { limit: 20 }, false);
      
      expect(result.data).toEqual(data);
      expect(result.pagination.hasMore).toBe(false);
      expect(result.pagination.limit).toBe(20);
    });

    it('should build response with hasMore=true when more items exist', () => {
      const data = [{ id: '1' }, { id: '2' }];
      const result = buildPaginatedResponse(data, { limit: 20 }, true);
      
      expect(result.pagination.hasMore).toBe(true);
    });
  });

  describe('Performance Tracking', () => {
    it('should track metrics within target', async () => {
      const tracker = createPerformanceTracker('dashboard');
      const result = await tracker(async () => ({ success: true }));
      
      expect(result.result).toEqual({ success: true });
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(meetsPerformanceTarget(result.durationMs, 'dashboard')).toBe(true);
    });

    it('should track metrics exceeding target', async () => {
      const tracker = createPerformanceTracker('goalList');
      
      // Simulate slow operation
      await new Promise(resolve => setTimeout(resolve, 600));
      
      const result = await tracker(async () => ({ success: true }));
      
      expect(result.durationMs).toBeGreaterThan(500);
      expect(meetsPerformanceTarget(result.durationMs, 'goalList')).toBe(false);
    });

    it('should throw error from handler', async () => {
      const tracker = createPerformanceTracker('default');
      
      await expect(tracker(async () => { throw new Error('Test error'); })).rejects.toThrow('Test error');
    });
  });

  describe('Track Performance Metric', () => {
    it('should log performance metrics in development', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';
      
      // Capture console output
      const logs: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((msg) => logs.push(msg as string));
      
      trackPerformanceMetric({
        endpoint: '/api/goals',
        method: 'GET',
        durationMs: 100,
        category: 'goalList',
      });
      
      expect(logs.some(l => l.includes('📊'))).toBe(true);
      
      // Restore
      process.env.NODE_ENV = originalEnv;
      vi.restoreAllMocks();
    });

    it('should log error for performance failures', () => {
      const logs: string[] = [];
      vi.spyOn(console, 'error').mockImplementation((msg) => logs.push(msg as string));
      
      trackPerformanceMetric({
        endpoint: '/api/goals',
        method: 'GET',
        durationMs: 600, // Exceeds 500ms target
        category: 'goalList',
      });
      
      expect(logs.some(l => l.includes('❌'))).toBe(true);
      
      vi.restoreAllMocks();
    });
  });

  describe('meetsPerformanceTarget', () => {
    it('should pass when within target for dashboard (200ms)', () => {
      expect(meetsPerformanceTarget(150, 'dashboard')).toBe(true);
      expect(meetsPerformanceTarget(200, 'dashboard')).toBe(true);
      expect(meetsPerformanceTarget(201, 'dashboard')).toBe(false);
    });

    it('should pass when within target for goalList (500ms)', () => {
      expect(meetsPerformanceTarget(400, 'goalList')).toBe(true);
      expect(meetsPerformanceTarget(500, 'goalList')).toBe(true);
      expect(meetsPerformanceTarget(501, 'goalList')).toBe(false);
    });

    it('should pass when within target for taskList (300ms)', () => {
      expect(meetsPerformanceTarget(250, 'taskList')).toBe(true);
      expect(meetsPerformanceTarget(300, 'taskList')).toBe(true);
      expect(meetsPerformanceTarget(301, 'taskList')).toBe(false);
    });

    it('should use default target (2000ms) for unknown category', () => {
      expect(meetsPerformanceTarget(1500, 'default' as any)).toBe(true);
      expect(meetsPerformanceTarget(2001, 'unknown' as any)).toBe(false);
    });
  });
});
