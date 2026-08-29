import { jwtVerify } from 'jose';
import type { NextRequest } from 'next/server';

const SESSION_SECRET = new TextEncoder().encode(
  process.env.BETTER_AUTH_SECRET || 'change-me-in-production'
);

export interface MobileSession {
  companyId: string;
}

/**
 * Extract and verify mobile session token from X-Company-Token header.
 * Returns companyId if valid, null otherwise.
 */
export async function verifyMobileToken(req: NextRequest): Promise<string | null> {
  const token = req.headers.get('x-company-token');
  if (!token) return null;
  
  try {
    const { payload } = await jwtVerify(token, SESSION_SECRET);
    if (typeof payload.companyId === 'string') {
      return payload.companyId;
    }
    return null;
  } catch {
    return null;
  }
}
