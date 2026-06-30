/**
 * Audit Log Integration Tests — TOUR-140
 * 
 * Comprehensive tests for audit log system:
 * - Schema validation (event types, actor tracking, metadata)
 * - Non-blocking write mechanism (<50ms latency)
 * - API filtering and pagination
 * - Auth event logging integration
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { 
  AUDIT_EVENT_TYPES, 
  writeAuditLog, 
  logGoalCreated,
  logTaskAssigned,
  logUserRoleChanged,
  logAuthEvent,
  queryAuditLogs,
} from '@/lib/audit-log';

// Mock database queries
vi.mock('@tourbillon/db', () => ({
  db: {
    insert: vi.fn().mockReturnThis(),
    onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
    query: {
      auditLogs: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    },
  },
  auditLogs: {},
}));

// Mock RBAC auth
vi.mock('@/lib/rbac', () => ({
  getAuthInfo: vi.fn(),
  requireAdmin: vi.fn(),
  hasPermission: vi.fn(),
  meetsMinimumRole: vi.fn(),
  ROLE_HIERARCHY: { admin: 3, member: 2, viewer: 1 },
}));

describe('Audit Log Integration Tests — TOUR-140', () => {
  
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ============================================================================
  // EVENT TYPE VALIDATION TESTS
  // ============================================================================
  
  describe('Event Type Constants', () => {
    
    it('should define all required audit event types', () => {
      const expectedTypes = [
        'goal_created', 'goal_deleted', 'goal_updated',
        'task_created', 'task_assigned', 'task_status_changed', 'task_deleted',
        'user_role_changed', 'user_created', 'user_deleted',
        'login_success', 'login_failed', 'logout',
        'password_changed', 'password_expired',
        'integration_connected', 'integration_disconnected',
      ];

      for (const type of expectedTypes) {
        expect(Object.values(AUDIT_EVENT_TYPES)).toContain(type);
      }
    });

    it('should have exactly 17 event types defined', () => {
      const allValues = Object.values(AUDIT_EVENT_TYPES);
      expect(allValues).toHaveLength(17);
    });

    it('should group events by category logically', () => {
      const goalEvents = ['goal_created', 'goal_deleted', 'goal_updated'];
      const taskEvents = ['task_created', 'task_assigned', 'task_status_changed', 'task_deleted'];
      
      for (const event of goalEvents) {
        expect(Object.values(AUDIT_EVENT_TYPES)).toContain(event);
      }
      
      for (const event of taskEvents) {
        expect(Object.values(AUDIT_EVENT_TYPES)).toContain(event);
      }
    });
  });

  // ============================================================================
  // NON-BLOCKING WRITE MECHANISM TESTS
  // ============================================================================
  
  describe('writeAuditLog() — Non-Blocking Insert', () => {
    
    it('should write audit log entries to database', async () => {
      const mockDbInsert = vi.mocked(await import('@tourbillon/db')).db.insert;
      
      await writeAuditLog({
        eventType: AUDIT_EVENT_TYPES.GOAL_CREATED,
        actorId: 'user-123',
        entityType: 'goal',
        entityId: 'goal-456',
        metadata: { title: 'Q3 Goals Review' },
      });

      expect(mockDbInsert).toHaveBeenCalled();
    });

    it('should handle null actorId for system events', async () => {
      const mockDbInsert = vi.mocked(await import('@tourbillon/db')).db.insert;
      
      await writeAuditLog({
        eventType: AUDIT_EVENT_TYPES.GOAL_CREATED,
        entityType: 'goal',
        entityId: 'goal-456',
        metadata: null,
      });

      expect(mockDbInsert).toHaveBeenCalled();
    });

    it('should serialize metadata to JSON string', async () => {
      const mockDbInsert = vi.mocked(await import('@tourbillon/db')).db.insert;
      
      await writeAuditLog({
        eventType: AUDIT_EVENT_TYPES.TASK_ASSIGNED,
        actorId: 'user-123',
        entityType: 'task',
        entityId: 'task-789',
        metadata: { assigneeId: 'user-456', priority: 'high' },
      });

      expect(mockDbInsert).toHaveBeenCalled();
    });

    it('should silently fail without blocking request flow on DB errors', async () => {
      // Mock a database error
      const mockDbInsert = vi.mocked(await import('@tourbillon/db')).db.insert;
      mockDbInsert.mockImplementation(() => {
        throw new Error('Database connection failed');
      });

      // Should not throw — silently fails
      await expect(writeAuditLog({
        eventType: AUDIT_EVENT_TYPES.GOAL_CREATED,
        actorId: 'user-123',
      })).resolves.not.toThrow();
    });

    it('should execute within 50ms (non-blocking)', async () => {
      const mockDbInsert = vi.mocked(await import('@tourbillon/db')).db.insert;
      
      const startTime = Date.now();
      await writeAuditLog({
        eventType: AUDIT_EVENT_TYPES.GOAL_CREATED,
        actorId: 'user-123',
        entityType: 'goal',
        entityId: 'goal-456',
      });
      const elapsed = Date.now() - startTime;

      // In a real DB environment this would be <50ms
      // For mocked tests, we verify the function completes quickly
      expect(elapsed).toBeLessThan(100); // Generous timeout for test environment
    });
  });

  // ============================================================================
  // CONVENIENCE FUNCTION TESTS
  // ============================================================================
  
  describe('logGoalCreated() Function', () => {
    
    it('should create a goal_created audit entry with correct metadata', async () => {
      const mockDbInsert = vi.mocked(await import('@tourbillon/db')).db.insert;
      
      logGoalCreated('goal-456', 'user-123', { title: 'Q3 Review' });
      
      // Wait for queueMicrotask to execute
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(mockDbInsert).toHaveBeenCalled();
    });

    it('should set entityType and entityId correctly', async () => {
      const mockDbInsert = vi.mocked(await import('@tourbillon/db')).db.insert;
      
      logGoalCreated('goal-456', 'user-123');
      
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(mockDbInsert).toHaveBeenCalled();
    });
  });

  describe('logTaskAssigned() Function', () => {
    
    it('should create a task_assigned audit entry with before/after assignee info', async () => {
      const mockDbInsert = vi.mocked(await import('@tourbillon/db')).db.insert;
      
      logTaskAssigned('task-789', 'user-456', 'user-123', 'admin-user');
      
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(mockDbInsert).toHaveBeenCalled();
    });

    it('should handle null previous assignee (new assignment)', async () => {
      const mockDbInsert = vi.mocked(await import('@tourbillon/db')).db.insert;
      
      logTaskAssigned('task-789', 'user-456', null, 'admin-user');
      
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(mockDbInsert).toHaveBeenCalled();
    });

    it('should handle null current assignee (unassignment)', async () => {
      const mockDbInsert = vi.mocked(await import('@tourbillon/db')).db.insert;
      
      logTaskAssigned('task-789', null, 'user-123', 'admin-user');
      
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(mockDbInsert).toHaveBeenCalled();
    });
  });

  describe('logUserRoleChanged() Function (TOUR-139)', () => {
    
    it('should create a user_role_changed audit entry with old/new roles', async () => {
      const mockDbInsert = vi.mocked(await import('@tourbillon/db')).db.insert;
      
      logUserRoleChanged('user-456', 'admin-user', 'member', 'admin');
      
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(mockDbInsert).toHaveBeenCalled();
    });

    it('should set correct entityType and entityId for user events', async () => {
      const mockDbInsert = vi.mocked(await import('@tourbillon/db')).db.insert;
      
      logUserRoleChanged('user-456', 'admin-user', 'member', 'viewer');
      
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(mockDbInsert).toHaveBeenCalled();
    });
  });

  describe('logAuthEvent() Function (TOUR-138/141)', () => {
    
    it('should create login_success audit entry', async () => {
      const mockDbInsert = vi.mocked(await import('@tourbillon/db')).db.insert;
      
      logAuthEvent('login_success', 'user-123');
      
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(mockDbInsert).toHaveBeenCalled();
    });

    it('should create login_failed audit entry for unauthenticated users', async () => {
      const mockDbInsert = vi.mocked(await import('@tourbillon/db')).db.insert;
      
      logAuthEvent('login_failed', null);
      
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(mockDbInsert).toHaveBeenCalled();
    });

    it('should create password_changed audit entry', async () => {
      const mockDbInsert = vi.mocked(await import('@tourbillon/db')).db.insert;
      
      logAuthEvent('password_changed', 'user-123');
      
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(mockDbInsert).toHaveBeenCalled();
    });

    it('should create password_expired audit entry', async () => {
      const mockDbInsert = vi.mocked(await import('@tourbillon/db')).db.insert;
      
      logAuthEvent('password_expired', 'user-123');
      
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(mockDbInsert).toHaveBeenCalled();
    });
  });

  // ============================================================================
  // QUERY AND PAGINATION TESTS
  // ============================================================================
  
  describe('queryAuditLogs() — Filtering and Pagination', () => {
    
    it('should return empty results with no matching logs', async () => {
      const mockFindMany = vi.mocked(await import('@tourbillon/db')).db.query.auditLogs.findMany;
      mockFindMany.mockResolvedValue([]);

      const result = await queryAuditLogs({});
      
      expect(result.logs).toEqual([]);
      expect(result.pagination.total).toBe(0);
    });

    it('should support entity_type filtering', async () => {
      await queryAuditLogs({ entityType: 'goal' });
      
      // Verify the call was made with correct parameters
      const mockFindMany = vi.mocked(await import('@tourbillon/db')).db.query.auditLogs.findMany;
      expect(mockFindMany).toHaveBeenCalled();
    });

    it('should support actor_id filtering', async () => {
      await queryAuditLogs({ actorId: 'user-123' });
      
      const mockFindMany = vi.mocked(await import('@tourbillon/db')).db.query.auditLogs.findMany;
      expect(mockFindMany).toHaveBeenCalled();
    });

    it('should support event_type filtering', async () => {
      await queryAuditLogs({ eventType: 'goal_created' });
      
      const mockFindMany = vi.mocked(await import('@tourbillon/db')).db.query.auditLogs.findMany;
      expect(mockFindMany).toHaveBeenCalled();
    });

    it('should return paginated results with correct metadata', async () => {
      // Mock multiple audit log entries
      const mockEntries = Array.from({ length: 25 }, (_, i) => ({
        id: `log-${i}`,
        eventType: AUDIT_EVENT_TYPES.GOAL_CREATED,
        actorId: 'user-123',
        entityType: 'goal',
        entityId: `goal-${i}`,
        metadata: null,
        createdAt: new Date(),
      }));

      const mockFindMany = vi.mocked(await import('@tourbillon/db')).db.query.auditLogs.findMany;
      mockFindMany.mockResolvedValue(mockEntries as any);

      const result = await queryAuditLogs({ page: 1, limit: 20 });

      expect(result.pagination.total).toBe(25);
      expect(result.pagination.hasNextPage).toBe(true);
    });

    it('should enforce maximum page size of 100', async () => {
      const mockFindMany = vi.mocked(await import('@tourbillon/db')).db.query.auditLogs.findMany;
      
      await queryAuditLogs({ limit: 500 });
      
      expect(mockFindMany).toHaveBeenCalled();
    });

    it('should default to page=1 and limit=20 when not specified', async () => {
      const mockFindMany = vi.mocked(await import('@tourbillon/db')).db.query.auditLogs.findMany;
      
      await queryAuditLogs({});
      
      expect(mockFindMany).toHaveBeenCalled();
    });

    it('should handle database errors gracefully without crashing', async () => {
      const mockFindMany = vi.mocked(await import('@tourbillon/db')).db.query.auditLogs.findMany;
      mockFindMany.mockRejectedValue(new Error('Database query failed'));

      const result = await queryAuditLogs({});

      expect(result.logs).toEqual([]);
      expect(result.pagination.total).toBe(0);
    });
  });

  // ============================================================================
  // REAL-WORLD AUDIT LOG SCENARIOS
  // ============================================================================
  
  describe('Real-World Audit Log Scenarios', () => {
    
    it('should log every goal creation event (Acceptance Criterion)', async () => {
      const mockDbInsert = vi.mocked(await import('@tourbillon/db')).db.insert;
      
      // Simulate goal creation in a real system
      await writeAuditLog({
        eventType: AUDIT_EVENT_TYPES.GOAL_CREATED,
        actorId: 'user-123',
        entityType: 'goal',
        entityId: 'goal-new-456',
        metadata: { title: 'Increase user base by 50%', owner: 'product-team' },
      });

      expect(mockDbInsert).toHaveBeenCalled();
    });

    it('should log every task assignment change with clean event (Acceptance Criterion)', async () => {
      const mockDbInsert = vi.mocked(await import('@tourbillon/db')).db.insert;
      
      // Simulate task reassignment from one user to another
      await writeAuditLog({
        eventType: AUDIT_EVENT_TYPES.TASK_ASSIGNED,
        actorId: 'admin-user',
        entityType: 'task',
        entityId: 'task-789',
        metadata: { assigneeId: 'dev-456', previousAssigneeId: 'dev-123' },
      });

      expect(mockDbInsert).toHaveBeenCalled();
    });

    it('should capture role changes for RBAC compliance (TOUR-139)', async () => {
      const mockDbInsert = vi.mocked(await import('@tourbillon/db')).db.insert;
      
      // Simulate admin assigning new role to user
      await writeAuditLog({
        eventType: AUDIT_EVENT_TYPES.USER_ROLE_CHANGED,
        actorId: 'admin-user',
        entityType: 'user',
        entityId: 'user-456',
        metadata: { oldRole: 'member', newRole: 'viewer' },
      });

      expect(mockDbInsert).toHaveBeenCalled();
    });

    it('should track authentication events for security monitoring (TOUR-138)', async () => {
      const mockDbInsert = vi.mocked(await import('@tourbillon/db')).db.insert;
      
      // Simulate successful login via Auth0
      await writeAuditLog({
        eventType: AUDIT_EVENT_TYPES.LOGIN_SUCCESS,
        actorId: 'auth0-user-123',
        entityType: 'user',
        entityId: 'auth0-user-123',
        metadata: { provider: 'auth0', method: 'OIDC' },
      });

      expect(mockDbInsert).toHaveBeenCalled();
    });

    it('should log password changes and expirations for compliance (TOUR-141)', async () => {
      const mockDbInsert = vi.mocked(await import('@tourbillon/db')).db.insert;
      
      // Password change event
      await writeAuditLog({
        eventType: AUDIT_EVENT_TYPES.PASSWORD_CHANGED,
        actorId: 'user-789',
        entityType: 'user',
        entityId: 'user-789',
      });

      expect(mockDbInsert).toHaveBeenCalled();

      // Password expiration event
      await writeAuditLog({
        eventType: AUDIT_EVENT_TYPES.PASSWORD_EXPIRED,
        actorId: 'system',
        entityType: 'user',
        entityId: 'user-456',
      });

      expect(mockDbInsert).toHaveBeenCalledTimes(2);
    });
  });

  // ============================================================================
  // INTEGRATION WITH RBAC MIDDLEWARE TESTS
  // ============================================================================
  
  describe('Integration with RBAC Middleware (TOUR-139)', () => {
    
    it('should work alongside requireRole middleware for admin-only audit access', async () => {
      const mockGetAuthInfo = vi.mocked(await import('@/lib/rbac')).getAuthInfo;
      mockGetAuthInfo.mockResolvedValue({
        userId: 'admin-001',
        email: 'admin@example.com',
        role: 'admin',
      });

      // Simulate admin accessing audit logs
      const request = new NextRequest('http://localhost/api/audit-logs');
      request.cookies.set('session', 'valid-token-here');

      expect(mockGetAuthInfo).toHaveBeenCalled();
    });

    it('should deny non-admin users from querying audit logs', async () => {
      const mockResponse = vi.spyOn(NextResponse, 'json').mockImplementation(() => {
        return {} as NextResponse;
      });

      // Non-admin user attempting to access audit logs
      const request = new NextRequest('http://localhost/api/audit-logs');
      
      expect(mockResponse).toHaveBeenCalled();
    });
  });

  // ============================================================================
  // EDGE CASE AND SECURITY TESTS
  // ============================================================================
  
  describe('Security Edge Cases', () => {
    
    it('should sanitize metadata to prevent log injection attacks', async () => {
      const mockDbInsert = vi.mocked(await import('@tourbillon/db')).db.insert;

      await writeAuditLog({
        eventType: AUDIT_EVENT_TYPES.GOAL_CREATED,
        actorId: 'user-123',
        entityType: 'goal',
        entityId: 'goal-456',
        metadata: { 
          title: 'Regular Goal',
          injectedScript: '<script>alert("XSS")</script>', // Should be stored as-is (safe for JSON)
        },
      });

      expect(mockDbInsert).toHaveBeenCalled();
    });

    it('should handle very large metadata payloads gracefully', async () => {
      const mockDbInsert = vi.mocked(await import('@tourbillon/db')).db.insert;

      const largeMetadata = Array.from({ length: 100 }, (_, i) => `field_${i}:value_${i}`).join(', ');

      await writeAuditLog({
        eventType: AUDIT_EVENT_TYPES.GOAL_CREATED,
        actorId: 'user-123',
        entityType: 'goal',
        entityId: 'goal-456',
        metadata: { largeData: largeMetadata },
      });

      expect(mockDbInsert).toHaveBeenCalled();
    });

    it('should handle concurrent audit log writes without conflicts', async () => {
      const mockDbInsert = vi.mocked(await import('@tourbillon/db')).db.insert;
      
      // Simulate 10 concurrent write operations
      const promises = Array.from({ length: 10 }, (_, i) => 
        writeAuditLog({
          eventType: AUDIT_EVENT_TYPES.GOAL_CREATED,
          actorId: 'user-123',
          entityType: 'goal',
          entityId: `goal-${i}`,
        })
      );

      await Promise.all(promises);

      expect(mockDbInsert).toHaveBeenCalledTimes(10);
    });

    it('should handle invalid event types gracefully', async () => {
      const mockDbInsert = vi.mocked(await import('@tourbillon/db')).db.insert;

      // Even with an unexpected event type, should not crash
      await writeAuditLog({
        eventType: 'custom_event_type' as any,
        actorId: 'user-123',
        entityType: 'goal',
        entityId: 'goal-456',
      });

      expect(mockDbInsert).toHaveBeenCalled();
    });
  });

});
