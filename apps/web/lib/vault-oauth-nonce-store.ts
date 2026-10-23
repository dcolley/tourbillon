/**
 * #112: server-side single-use store for vault OAuth state nonces.
 *
 * Uses Better Auth's existing `verification` table (identifier / value / expiresAt), so no
 * migration is needed. Rows are namespaced by `OAUTH_NONCE_IDENTIFIER` and hold only the
 * SHA-256 of the nonce, never the nonce itself.
 *
 * - authorize: `recordOAuthNonce` inserts one row per flow, expiring with the state. Expired
 *   rows for this identifier are swept at the same time.
 * - callback: `consumeOAuthNonce` is a single `DELETE … WHERE value = hash AND expiresAt > now
 *   RETURNING id`. Postgres runs it atomically, so a state can be redeemed at most once, even
 *   with two concurrent callbacks. A replay finds no row and is refused.
 */
import { createHash, randomUUID } from 'node:crypto';
import { db, verification } from '@tourbillon/db';
import { and, eq, gt, lt } from 'drizzle-orm';

export const OAUTH_NONCE_IDENTIFIER = 'tourbillon:vault-oauth-state';

function hashNonce(nonce: string): string {
  return createHash('sha256').update(nonce).digest('hex');
}

/** Remember an issued nonce until `expiresAt` (and sweep this identifier's expired rows). */
export async function recordOAuthNonce(nonce: string, expiresAt: Date): Promise<void> {
  const now = new Date();
  await db
    .delete(verification)
    .where(and(eq(verification.identifier, OAUTH_NONCE_IDENTIFIER), lt(verification.expiresAt, now)));
  await db.insert(verification).values({
    id: randomUUID(),
    identifier: OAUTH_NONCE_IDENTIFIER,
    value: hashNonce(nonce),
    expiresAt,
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * Redeem a nonce. True exactly once per recorded, unexpired nonce; false for an unknown,
 * expired or already-used one.
 */
export async function consumeOAuthNonce(nonce: string): Promise<boolean> {
  const rows = await db
    .delete(verification)
    .where(
      and(
        eq(verification.identifier, OAUTH_NONCE_IDENTIFIER),
        eq(verification.value, hashNonce(nonce)),
        gt(verification.expiresAt, new Date()),
      ),
    )
    .returning({ id: verification.id });
  return rows.length > 0;
}
