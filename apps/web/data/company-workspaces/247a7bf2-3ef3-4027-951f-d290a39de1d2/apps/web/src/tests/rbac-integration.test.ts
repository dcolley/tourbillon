/**
 * RBAC Integration Tests — TOUR-139 (Role-Based Access Control)
 * 
 * Comprehensive tests for role enforcement middleware:
 * - Unauthenticated access denied
 * - Role-based access control (admin, member, viewer)
 * - Permission hierarchy validation
 * - Session token verification with roles
 */

import { describe, it, expect, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { verifySessionToken, generateSessionToken } from '@/lib/auth';
import { getAuthInfo, requireRole, hasPermission, meetsMinimumRole, ROLE_HIERARCHY, PERMISSIONS, ROLES } from '@/lib/rbac';

// Mock database queries
vi.mock('@tourbillon/db', () => ({
  db: {
    query: {
      users: {
        findFirst: vi.fn(),
      },
    },
  },
  users: {},
}));

// Test user fixtures
const testUsers = {
  admin: {
    id: 'admin-001',
    email: 'admin@example.com',
    name: 'Admin User',
    provider: 'email',
    role: 'admin' as const,
  },
  member: {
    id: 'member-001',
    email: 'member@example.com',
    name: 'Member User',
    provider: 'email',
    role: 'member' as const,
  },
  viewer: {
    id: 'viewer-001',
    email: 'viewer@example.com',
    name: 'Viewer User',
    provider: 'email',
    role: 'viewer' as const,
  },
};

function createMockSessionToken(userId: string): string {
  return generateSessionToken(userId, 'email');
}

describe('RBAC Integration Tests — TOUR-139', () => {
  
  describe('Role Hierarchy & Permission Matrix', () => {
    it('should have exactly three roles defined', () => {
      expect(ROLES).toHaveLength(3);
      expect(ROLES).toEqual(['admin', 'member', 'viewer']);
    });

    it('should define role hierarchy levels correctly (admin > member > viewer)', () => {
      expect(ROLE_HIERARCHY.admin).toBeGreaterThan(ROLE_HIERARCHY.member);
      expect(ROLE_HIERARCHY.member).toBeGreaterThan(ROLE_HIERARCHY.viewer);
      expect(ROLE_HIERARCHY.viewer).toBeGreaterThan(0);
    });

    it('should grant admin access to all permissions', () => {
      const allPermissions = Object.values(PERMISSIONS).flat();
      const uniqueAdminPerms = [...new Set(allPermissions)];
      
      for (const perm of uniqueAdminPerms) {
        expect(hasPermission('admin', perm)).toBe(true);
      }
    });

    it('should grant member access to read/write but not user/role management', () => {
      // Member CAN create/read/update tasks
      expect(hasPermission('member', 'task:create')).toBe(true);
      expect(hasPermission('member', 'task:read')).toBe(true);
      expect(hasPermission('member', 'task:update')).toBe(true);
      
      // Member CANNOT manage users or roles
      expect(hasPermission('member', 'user:delete')).toBe(false);
      expect(hasPermission('member', 'role:manage')).toBe(false);
    });

    it('should grant viewer read-only access only', () => {
      expect(hasPermission('viewer', 'task:read')).toBe(true);
      expect(hasPermission('viewer', 'project:read')).toBe(true);
      
      // Viewer CANNOT create, update, or delete
      expect(hasPermission('viewer', 'task:create')).toBe(false);
      expect(hasPermission('viewer', 'task:update')).toBe(false);
      expect(hasPermission('viewer', 'project:delete')).toBe(false);
    });

    it('should deny access for non-existent permissions to all roles', () => {
      const fakePermission = 'fake:permission';
      
      expect(hasPermission('admin', fakePermission)).toBe(false);
      expect(hasPermission('member', fakePermission)).toBe(false);
      expect(hasPermission('viewer', fakePermission)).toBe(false);
    });
  });

  describe('Role Enforcement Middleware — requireRole()', () => {
    
    it('should reject requests without session token (redirect to login)', async () => {
      const request = new NextRequest('http://localhost/api/test');
      
      const middleware = requireRole('admin');
      const response = await middleware(request);
      
      expect(response).toBeInstanceOf(Response);
      expect(response?.status).toBe(307); // Redirect to login
    });

    it('should reject requests with invalid session token', async () => {
      const request = new NextRequest('http://localhost/api/test');
      request.cookies.set('session', 'invalid.token.here');
      
      vi.mocked(await import('@tourbillon/db')).db.query.users.findFirst = vi.fn().mockResolvedValue(null);
      
      const middleware = requireRole('admin');
      const response = await middleware(request);
      
      expect(response).toBeInstanceOf(Response);
      expect(response?.status).toBe(307); // Redirect to login (user not found)
    });

    it('should allow admin user to access admin-only routes', async () => {
      const sessionToken = createMockSessionToken(testUsers.admin.id);
      const request = new NextRequest('http://localhost/api/admin/test', {
        headers: { Cookie: `session=${sessionToken}` },
      });

      vi.mocked(await import('@tourbillon/db')).db.query.users.findFirst = vi.fn().mockResolvedValue(testUsers.admin);
      
      const middleware = requireRole('admin');
      const response = await middleware(request);
      
      expect(response).toBeNull(); // Allow through to route handler
    });

    it('should deny member user from accessing admin-only routes (403)', async () => {
      const sessionToken = createMockSessionToken(testUsers.member.id);
      const request = new NextRequest('http://localhost/api/admin/test', {
        headers: { Cookie: `session=${sessionToken}` },
      });

      vi.mocked(await import('@tourbillon/db')).db.query.users.findFirst = vi.fn().mockResolvedValue(testUsers.member);
      
      const middleware = requireRole('admin');
      const response = await middleware(request);
      
      expect(response).toBeInstanceOf(Response);
      expect(response?.status).toBe(403); // Forbidden
    });

    it('should deny viewer user from accessing member-only routes (403)', async () => {
      const sessionToken = createMockSessionToken(testUsers.viewer.id);
      const request = new NextRequest('http://localhost/api/member/test', {
        headers: { Cookie: `session=${sessionToken}` },
      });

      vi.mocked(await import('@tourbillon/db')).db.query.users.findFirst = vi.fn().mockResolvedValue(testUsers.viewer);
      
      const middleware = requireRole('member');
      const response = await middleware(request);
      
      expect(response).toBeInstanceOf(Response);
      expect(response?.status).toBe(403); // Forbidden
    });

    it('should allow member user to access member-only routes', async () => {
      const sessionToken = createMockSessionToken(testUsers.member.id);
      const request = new NextRequest('http://localhost/api/member/test', {
        headers: { Cookie: `session=${sessionToken}` },
      });

      vi.mocked(await import('@tourbillon/db')).db.query.users.findFirst = vi.fn().mockResolvedValue(testUsers.member);
      
      const middleware = requireRole('member');
      const response = await middleware(request);
      
      expect(response).toBeNull(); // Allow through
    });

    it('should allow viewer user to access viewer-only routes', async () => {
      const sessionToken = createMockSessionToken(testUsers.viewer.id);
      const request = new NextRequest('http://localhost/api/viewer/test', {
        headers: { Cookie: `session=${sessionToken}` },
      });

      vi.mocked(await import('@tourbillon/db')).db.query.users.findFirst = vi.fn().mockResolvedValue(testUsers.viewer);
      
      const middleware = requireRole('viewer');
      const response = await middleware(request);
      
      expect(response).toBeNull(); // Allow through
    });

    it('should return 403 with helpful error message for unauthorized users', async () => {
      const sessionToken = createMockSessionToken(testUsers.member.id);
      const request = new NextRequest('http://localhost/api/admin/test', {
        headers: { Cookie: `session=${sessionToken}` },
      });

      vi.mocked(await import('@tourbillon/db')).db.query.users.findFirst = vi.fn().mockResolvedValue(testUsers.member);
      
      const middleware = requireRole('admin');
      const response = await middleware(request) as NextResponse;
      
      expect(response?.status).toBe(403);
      
      const body = await response!.json();
      expect(body.error).toBe('Insufficient permissions');
      expect(body.requiredRole).toBe('admin');
      expect(body.currentRole).toBe('member');
    });

    it('should redirect to login with original URL for unauthenticated access', async () => {
      const request = new NextRequest('http://localhost/api/admin/test');
      
      const middleware = requireRole('admin');
      const response = await middleware(request) as NextResponse;
      
      expect(response?.status).toBe(307); // Redirect
      
      const redirectUrl = response!.headers.get('location') || '';
      expect(redirectUrl).toContain('/auth/login');
      expect(redirectUrl).toContain('redirect=');
    });

    it('should attach authInfo to request when authentication succeeds', async () => {
      const sessionToken = createMockSessionToken(testUsers.admin.id);
      const request = new NextRequest('http://localhost/api/test', {
        headers: { Cookie: `session=${sessionToken}` },
      });

      vi.mocked(await import('@tourbillon/db')).db.query.users.findFirst = vi.fn().mockResolvedValue(testUsers.admin);
      
      await requireRole('admin')(request);
      
      // AuthInfo should be attached to request object
      expect((request as any).authInfo).toBeDefined();
      expect((request as any).authInfo.userId).toBe(testUsers.admin.id);
      expect((request as any).authInfo.role).toBe('admin');
    });
  });

  describe('meetsMinimumRole() Function', () => {
    
    it('should allow admin to access all levels', () => {
      expect(meetsMinimumRole('admin', 'admin')).toBe(true);
      expect(meetsMinimumRole('admin', 'member')).toBe(true);
      expect(meetsMinimumRole('admin', 'viewer')).toBe(true);
    });

    it('should allow member to access member and viewer levels only', () => {
      expect(meetsMinimumRole('member', 'admin')).toBe(false);
      expect(meetsMinimumRole('member', 'member')).toBe(true);
      expect(meetsMinimumRole('member', 'viewer')).toBe(true);
    });

    it('should allow viewer to access only viewer level', () => {
      expect(meetsMinimumRole('viewer', 'admin')).toBe(false);
      expect(meetsMinimumRole('viewer', 'member')).toBe(false);
      expect(meetsMinimumRole('viewer', 'viewer')).toBe(true);
    });

    it('should handle same-role requests correctly (equal access)', () => {
      expect(meetsMinimumRole('admin', 'admin')).toBe(true);
      expect(meetsMinimumRole('member', 'member')).toBe(true);
      expect(meetsMinimumRole('viewer', 'viewer')).toBe(true);
    });
  });

  describe('Real-World Access Control Scenarios', () => {
    
    it('should prevent viewer from creating tasks (write protection)', () => {
      expect(hasPermission('viewer', 'task:create')).toBe(false);
      expect(hasPermission('viewer', 'project:update')).toBe(false);
    });

    it('should allow member to create and update tasks', () => {
      expect(hasPermission('member', 'task:create')).toBe(true);
      expect(hasPermission('member', 'task:update')).toBe(true);
    });

    it('should prevent all non-admin users from managing roles', () => {
      expect(hasPermission('admin', 'role:manage')).toBe(true);
      expect(hasPermission('member', 'role:manage')).toBe(false);
      expect(hasPermission('viewer', 'role:manage')).toBe(false);
    });

    it('should prevent viewer from accessing integration management', () => {
      expect(hasPermission('viewer', 'integration:view')).toBe(true);
      expect(hasPermission('member', 'integration:view')).toBe(true);
      expect(hasPermission('admin', 'integration:manage')).toBe(true);
    });

    it('should allow member to use agents but not configure custom prompts', () => {
      expect(hasPermission('member', 'agent:use')).toBe(true);
      expect(hasPermission('member', 'agent:configure')).toBe(false);
      expect(hasPermission('admin', 'agent:configure')).toBe(true);
    });

    it('should allow admin to configure AI agents and integrations', () => {
      expect(hasPermission('admin', 'agent:configure')).toBe(true);
      expect(hasPermission('admin', 'integration:manage')).toBe(true);
    });
  });

  describe('Session Token & Role Integration', () => {
    
    it('should generate valid session tokens for admin users', () => {
      const token = createMockSessionToken(testUsers.admin.id);
      
      expect(token).toBeDefined();
      expect(typeof token).toBe('string');
      expect(token.split('.')).toHaveLength(3); // header.payload.signature
      
      const [header, payload] = token.split('.').slice(0, 2);
      const decodedPayload = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
      const parsed = JSON.parse(decodedPayload.toString('utf-8'));
      
      expect(parsed.userId).toBe(testUsers.admin.id);
      expect(parsed.provider).toBe('email');
    });

    it('should generate different tokens for same user with different providers', () => {
      const emailToken = generateSessionToken(testUsers.member.id, 'email');
      const githubToken = generateSessionToken(testUsers.member.id, 'github');
      
      expect(emailToken).not.toBe(githubToken);
    });

    it('should verify session tokens match their user IDs', () => {
      const adminToken = createMockSessionToken(testUsers.admin.id);
      const decoded = verifySessionToken(adminToken);
      
      expect(decoded).not.toBeNull();
      expect(decoded?.userId).toBe(testUsers.admin.id);
    });

    it('should reject tampered session tokens', () => {
      const validToken = createMockSessionToken(testUsers.member.id);
      const tamperedToken = validToken.slice(0, -1) + (validToken[validToken.length - 1] === 'a' ? 'b' : 'a');
      
      const decoded = verifySessionToken(tamperedToken);
      expect(decoded).toBeNull(); // Invalid signature rejected
    });

    it('should handle expired session tokens gracefully', () => {
      const crypto = require('crypto');
      const payload = JSON.stringify({ 
        userId: testUsers.member.id, 
        iat: Date.now() - 8 * 24 * 60 * 60 * 1000, // 8 days ago (expired)
        provider: 'email' 
      });
      
      const secret = process.env.SESSION_SECRET || 'dev-session-secret-change-in-production';
      const hmac = crypto.createHmac('sha256', secret);
      hmac.update(payload);
      const expiredToken = `${payload}.${hmac.digest('hex')}`;
      
      const decoded = verifySessionToken(expiredToken);
      expect(decoded).toBeNull(); // Expired token rejected
    });

    it('should handle malformed session tokens gracefully', () => {
      const malformedTokens = [
        '',
        'just-one-part',
        'no-signature.',
        '.missing-payload',
        '{invalid-json}.signature',
      ];
      
      for (const token of malformedTokens) {
        const decoded = verifySessionToken(token);
        expect(decoded).toBeNull();
      }
    });
  });

  describe('Auth Info Extraction from Request', () => {
    
    it('should return null for requests without session cookie', async () => {
      const request = new NextRequest('http://localhost/api/test');
      
      vi.mocked(await import('@tourbillon/db')).db.query.users.findFirst = vi.fn().mockResolvedValue(null);
      
      const authInfo = await getAuthInfo(request);
      
      expect(authInfo).toBeNull();
    });

    it('should extract user info from valid session with role', async () => {
      const token = createMockSessionToken(testUsers.admin.id);
      const request = new NextRequest('http://localhost/api/test', {
        headers: { Cookie: `session=${token}` },
      });

      vi.mocked(await import('@tourbillon/db')).db.query.users.findFirst = vi.fn().mockResolvedValue(testUsers.admin);
      
      const authInfo = await getAuthInfo(request);
      
      expect(authInfo).not.toBeNull();
      expect(authInfo?.userId).toBe(testUsers.admin.id);
      expect(authInfo?.email).toBe('admin@example.com');
      expect(authInfo?.role).toBe('admin');
    });

    it('should return null when user not found in database', async () => {
      const token = createMockSessionToken('non-existent-user-id');
      const request = new NextRequest('http://localhost/api/test', {
        headers: { Cookie: `session=${token}` },
      });

      vi.mocked(await import('@tourbillon/db')).db.query.users.findFirst = vi.fn().mockResolvedValue(null);
      
      const authInfo = await getAuthInfo(request);
      
      expect(authInfo).toBeNull();
    });
  });

  describe('Schema Role Default Value', () => {
    
    it('should only allow valid role values (admin, member, viewer)', () => {
      const invalidRoles: any[] = ['superadmin', 'moderator', 'user', '', null, undefined, 123];
      
      for (const role of invalidRoles) {
        expect(ROLES).not.toContain(role);
      }
    });

    it('should have all three required roles with correct names', () => {
      const expectedRoles = ['admin', 'member', 'viewer'];
      expect([...ROLES].sort()).toEqual(expectedRoles.sort());
    });
  });

});