/**
 * #112: server-side single-use store for vault OAuth state nonces.
 *
 * Uses Better Auth's existing `verification` table (identifier / value / expiresAt) — no
 * migration. Rows are namespaced by OAUTH_NONCE_IDENTIFIER and hold only the SHA-256 of the
 * nonce, never the nonce itself.
 *
 * authorize: recordOAuthNonce inserts one row per flow (and sweeps expired rows for this id).
 * callback: consumeOAuthNonce is a single DELETE … WHERE value = hash AND expiresAt > now
 * RETURNING id — atomic in Postgres, so a state redeems at most once under concurrency.
 */
import { createHash, randomUUID } from 'node:crypto';
import { db, verification } from '@tourbillon/db';
import { and, eq, gt, lt } from 'drizzle-orm';

export const OAUTH_NONCE_IDENTIFIER = 'tourbillon:vault-oauth-state';

function hashNonce(nonce: string): string {
  return createHash('sha256').update(nonce).digest('hex');
}

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

/** True exactly once per recorded, unexpired nonce; false for unknown / expired / already used. */
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
