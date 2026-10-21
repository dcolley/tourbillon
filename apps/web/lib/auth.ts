/**
 * Better Auth configuration
 * Provides user authentication with email/password and session management
 *
 * BETTER_AUTH_SECRET is checked with requireSecret (lib/require-secret.ts) when the auth
 * instance is first needed for a request, not at module import: `next build` imports this
 * module while collecting page data, where the runtime env may be absent. The check runs on
 * every getAuth() call, so a request never reaches Better Auth with an unacceptable secret.
 */

import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { db } from '@tourbillon/db';
import * as schema from '@tourbillon/db';
import type { BoardRequestHeaders } from './board-auth';
import { requireSecret } from './require-secret';

export const AUTH_SECRET_ENV = 'BETTER_AUTH_SECRET';

function createAuth(secret: string) {
  return betterAuth({
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema,
    }),
    secret,
    baseURL: process.env.BETTER_AUTH_URL || 'http://localhost:3002',
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
    },
    session: {
      cookieCache: {
        enabled: true,
        maxAge: 5 * 60, // 5 minutes
      },
    },
  });
}

type AuthInstance = ReturnType<typeof createAuth>;

let cached: { secret: string; instance: AuthInstance } | null = null;

/**
 * The Better Auth instance. Throws SecretConfigError (naming the variable, never its value)
 * when BETTER_AUTH_SECRET is unset, short or a placeholder. Pass the incoming request headers
 * so the loopback-only local-dev opt-in can apply.
 */
export function getAuth(headers?: BoardRequestHeaders): AuthInstance {
  const secret = requireSecret(AUTH_SECRET_ENV, headers);
  if (!cached || cached.secret !== secret) {
    cached = { secret, instance: createAuth(secret) };
  }
  return cached.instance;
}

/** Handler for the catch-all route; checks the secret per request using that request's headers. */
export const auth = {
  handler: async (request: Request): Promise<Response> => getAuth(request.headers).handler(request),
};

export type Session = AuthInstance['$Infer']['Session']['session'];
export type User = AuthInstance['$Infer']['Session']['user'];
