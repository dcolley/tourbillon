import type { NextRequest } from 'next/server';
import { hasAgentToken, verifyBoardJwt } from './board-auth';

export interface MobileSession {
  companyId: string;
}

/**
 * Extract and verify the board JWT from the X-Company-Token header.
 * Returns companyId if valid, null otherwise.
 *
 * #105: a request that also carries an agent run/chat token is never board.
 */
export async function verifyMobileToken(req: NextRequest): Promise<string | null> {
  const token = req.headers.get('x-company-token');
  if (!token) return null;
  if (hasAgentToken(req.headers.get('authorization'))) return null;
  return verifyBoardJwt(token);
}
