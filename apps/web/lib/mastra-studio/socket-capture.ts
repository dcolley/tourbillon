/**
 * #348 — capture the TRUE TCP peer address at the Node HTTP boundary.
 *
 * Next 16 hands route handlers a Web Request that does not expose
 * req.socket, while the Studio guard's source of truth must be the socket
 * remote address (never X-Forwarded-* / X-Real-IP / Forwarded /
 * X-Forwarded-Host — those are client-forgeable). This module wraps
 * http.Server's 'request' dispatch in a per-request AsyncLocalStorage
 * holding `req.socket.remoteAddress`, read back by the Studio route via
 * getCapturedSocketAddress(). The value comes from Node's own socket object
 * — a client cannot forge it.
 *
 * Scoped narrowly: it only annotates an async context; it never changes
 * routing, headers or responses of any route, Studio or Tourbillon.
 * Activated once per process from apps/web/instrumentation.ts register().
 */
import { AsyncLocalStorage } from 'node:async_hooks';

interface StudioPeerContext {
  socketRemoteAddress?: string;
}

/**
 * instrumentation.ts and route modules are compiled into SEPARATE server
 * bundles, so the store must be shared via globalThis — otherwise the
 * patched http layer writes into one AsyncLocalStorage while the route
 * reads a second, empty one.
 */
const globalForPeer = globalThis as unknown as {
  __tourbillonStudioPeerStorage?: AsyncLocalStorage<StudioPeerContext>;
  __tourbillonStudioPeerPatched?: boolean;
};

function peerStorage(): AsyncLocalStorage<StudioPeerContext> {
  return (globalForPeer.__tourbillonStudioPeerStorage ??=
    new AsyncLocalStorage<StudioPeerContext>());
}

/** The socket address captured for the current request, if any. */
export function getCapturedSocketAddress(): string | null {
  return peerStorage().getStore()?.socketRemoteAddress ?? null;
}

/** Run a handler inside a peer context (test seam + production patch). */
export function runWithCapturedSocket<T>(
  socketRemoteAddress: string | undefined,
  fn: () => T,
): T {
  return peerStorage().run({ socketRemoteAddress }, fn);
}

/** Idempotent; safe to call from register() only in the Node runtime. */
export function patchNodeHttpPeerCapture(): void {
  if (globalForPeer.__tourbillonStudioPeerPatched) return;
  globalForPeer.__tourbillonStudioPeerPatched = true;
  const http = require('node:http') as typeof import('node:http');
  const proto = http.Server.prototype as unknown as {
    emit(event: string, ...args: unknown[]): boolean;
  };
  const originalEmit = proto.emit;
  proto.emit = function patchedEmit(
    this: unknown,
    event: string,
    ...args: unknown[]
  ): boolean {
    if (event === 'request') {
      const req = args[0] as { socket?: { remoteAddress?: string } } | undefined;
      const addr = req?.socket?.remoteAddress;
      if (typeof addr === 'string') {
        return peerStorage().run({ socketRemoteAddress: addr }, () =>
          originalEmit.apply(this, [event, ...args] as Parameters<typeof originalEmit>),
        );
      }
    }
    return originalEmit.apply(this, [event, ...args] as Parameters<typeof originalEmit>);
  };
  console.log('[mastra-studio] peer socket capture active');
}
