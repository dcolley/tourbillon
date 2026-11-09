/**
 * #112: durable single-use store for vault OAuth nonces (Better Auth `verification` table).
 * No migration. Rows: identifier = OAUTH_NONCE_IDENTIFIER, value = SHA-256(nonce).
 * Both DELETE predicates keep `identifier = OAUTH_NONCE_IDENTIFIER` (M4).
 * Clock: oauthNowMs() from vault-oauth-state (TB112_NOW_MS in tests).
 */
import { createHash, randomUUID } from 'node:crypto';
import { db, verification } from '@tourbillon/db';
import { and, eq, gt, lt } from 'drizzle-orm';
import { oauthNowMs } from './vault-oauth-state';

export const OAUTH_NONCE_IDENTIFIER = 'tourbillon:vault-oauth-state';

function hashNonce(nonce: string): string {
  return createHash('sha256').update(nonce).digest('hex');
}

export async function recordOAuthNonce(nonce: string, expiresAt: Date): Promise<void> {
  const now = new Date(oauthNowMs());
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

/** Atomic claim. False for unknown / expired / already used. */
export async function consumeOAuthNonce(nonce: string): Promise<boolean> {
  const now = new Date(oauthNowMs());
  const rows = await db
    .delete(verification)
    .where(
      and(
        eq(verification.identifier, OAUTH_NONCE_IDENTIFIER),
        eq(verification.value, hashNonce(nonce)),
        gt(verification.expiresAt, now),
      ),
    )
    .returning({ id: verification.id });
  return rows.length > 0;
}
