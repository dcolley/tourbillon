/**
 * APR-2: hashing helpers for hitl v0 (server side; uses node:crypto).
 * - `argsHash(args)` = b64url(SHA-256(JCS(args)))
 * - `hitlEventHash(event)` = b64url(SHA-256(JCS(event without `hash`)))
 */
import { createHash } from 'node:crypto';
import { jcs } from './jcs';

export function sha256b64url(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('base64url');
}

export function argsHash(args: unknown): string {
  return sha256b64url(jcs(args));
}

export function hitlEventHash(event: Record<string, unknown>): string {
  const { hash: _hash, ...rest } = event;
  return sha256b64url(jcs(rest));
}

/** True when each event's prevHash links to the previous hash and every hash recomputes. */
export function verifyHitlEventChain(events: Array<Record<string, unknown>>): boolean {
  let prev: string | null = null;
  for (const e of events) {
    if ((e.prevHash ?? null) !== prev) return false;
    if (e.hash !== hitlEventHash(e)) return false;
    prev = e.hash as string;
  }
  return true;
}
