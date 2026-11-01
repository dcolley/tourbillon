/**
 * Session lifecycle — create / get / destroy against injected SessionStore + HostClient.
 *
 * No Docker, no filesystem, no image pulls in this module: every host interaction goes
 * through the injected HostClient (mockable). Gates are re-checked here as defence in
 * depth even though the API route checks first.
 */
import { randomBytes } from 'node:crypto';
import {
  assertSafeRef,
  companyRefFor,
  containerName as buildContainerName,
  CONTAINER_VNC_PORT,
  KASM_IMAGE,
  MAX_ACTIVE_SEATS,
  PORT_BASE,
} from './constants';
import { assertComputerGates } from './gates';
import { mountsForAgent } from './ensure-company-dirs';
import {
  GateError,
  SeatCapExceededError,
  type ComputerContext,
  type ContainerSpec,
  type HostClient,
  type SessionStore,
} from './types';
import type { ComputerSession } from './types';

export const DEFAULT_SHM_SIZE_BYTES = 512 * 1024 * 1024; // 512 MB (browser shared memory)
export const DEFAULT_MEMORY_BYTES = 2 * 1024 * 1024 * 1024; // ~2 GiB per seat (Ops brief)
export const DEFAULT_NANO_CPUS = Math.round(1.5 * 1_000_000_000); // ~1.5 cores (Ops brief)

export interface LifecycleDeps {
  store: SessionStore;
  hostClient: HostClient;
  /** Injectable for deterministic tests. */
  now?: () => Date;
  newSessionId?: () => string;
  /** Image override (tests / allowlist experiments). Defaults to the pinned KASM_IMAGE. */
  image?: string;
}

/** VNC password: long, URL-safe, never logged. */
export function generateVncPassword(length = 24): string {
  return randomBytes(32)
    .toString('base64url')
    .replace(/[_-]/g, '')
    .slice(0, length);
}

/** Host port allocation: PORT_BASE upward, skipping ports held by live sessions. */
export async function allocatePort(store: SessionStore, companyId: string): Promise<number> {
  const taken = new Set(await store.listActivePorts(companyId));
  let port = PORT_BASE;
  while (taken.has(port)) port += 1;
  return port;
}

/** The full container spec for one agent seat (canonical /opt mounts only). */
export function buildContainerSpec(
  ctx: ComputerContext,
  vncPort: number,
  image: string = KASM_IMAGE,
): ContainerSpec {
  assertSafeRef(ctx.agentUrlKey, 'agentUrlKey');
  assertSafeRef(ctx.companyId, 'companyId');
  const name = buildContainerName(companyRefFor(ctx.companySlug, ctx.companyId), ctx.agentUrlKey);
  return {
    name,
    image,
    containerPort: CONTAINER_VNC_PORT,
    hostPort: vncPort,
    env: {
      VNC_PORT: String(CONTAINER_VNC_PORT),
      VNC_PW: generateVncPassword(),
    },
    mounts: mountsForAgent(ctx.companyId, ctx.agentUrlKey),
    shmSizeBytes: DEFAULT_SHM_SIZE_BYTES,
    memoryBytes: DEFAULT_MEMORY_BYTES,
    nanoCpus: DEFAULT_NANO_CPUS,
  };
}

/**
 * Create (or resume) the per-agent seat. Idempotent: an existing non-destroyed session
 * for the agent is returned untouched. Throws GateError before any host call when
 * either gate is closed.
 */
export async function createSession(ctx: ComputerContext, deps: LifecycleDeps): Promise<ComputerSession> {
  assertComputerGates(ctx);
  const now = deps.now?.() ?? new Date();

  const existing = await deps.store.findActiveByAgent(ctx.agentId);
  if (existing) return existing;

  // Host-wide seat cap (Ops brief: ~4 TEST seats). Checked after the reuse short-circuit
  // so an agent's own live seat never counts against itself.
  const active = await deps.store.countActiveSessions();
  if (active >= MAX_ACTIVE_SEATS) {
    throw new SeatCapExceededError(
      `Company Computer seat cap reached: ${active}/${MAX_ACTIVE_SEATS} seats active on this host. ` +
        `Close a seat (computerCloseSession) before opening a new one.`,
    );
  }

  await deps.hostClient.ensureDirs([
    // data dir + this agent's home dir (canonical /opt layout; dry-run no-ops)
    ...mountsForAgent(ctx.companyId, ctx.agentUrlKey).map((m) => m.source),
  ]);

  const image = deps.image ?? KASM_IMAGE;
  const vncPort = await allocatePort(deps.store, ctx.companyId);
  const spec = { ...buildContainerSpec(ctx, vncPort, image) };

  const started = await deps.hostClient.startContainer(spec); // dry-run refuses here
  const session: ComputerSession = {
    id: deps.newSessionId?.() ?? `ccs-${randomBytes(8).toString('hex')}`,
    companyId: ctx.companyId,
    agentId: ctx.agentId,
    agentUrlKey: ctx.agentUrlKey,
    containerName: spec.name,
    image,
    vncPort,
    status: 'running',
    createdAt: now,
    updatedAt: now,
    startedAt: started.startedAt,
    destroyedAt: null,
    lastActivityAt: now,
    takeoverStatus: null,
    takeoverUserId: null,
  };
  return deps.store.insert(session);
}

export interface GetSessionOptions {
  /** Probe the container and demote dead sessions to 'stopped' (default false = registry read). */
  probe?: boolean;
}

/** Registry read for this agent's seat; optional host health probe. Null when none exists. */
export async function getSession(
  ctx: Pick<ComputerContext, 'companyId' | 'agentId' | 'companyHasComputer' | 'agentHasComputer'>,
  deps: Pick<LifecycleDeps, 'store' | 'hostClient' | 'now'>,
  options: GetSessionOptions = {},
): Promise<ComputerSession | null> {
  assertComputerGates(ctx);
  const session = await deps.store.findActiveByAgent(ctx.agentId);
  if (!session) return null;
  if (options.probe && session.status === 'running') {
    const alive = await deps.hostClient.healthCheck(session.containerName);
    if (!alive) {
      const updated = await deps.store.update(session.id, {
        status: 'stopped',
        updatedAt: deps.now?.() ?? new Date(),
      });
      return updated ?? { ...session, status: 'stopped' };
    }
  }
  return session;
}

/**
 * Destroy this agent's seat. Idempotent: no active session -> { destroyed: false }.
 * Host teardown failures do NOT leave the registry row live — the row is marked
 * destroyed either way and the error is reported alongside.
 */
export async function destroySession(
  ctx: Pick<ComputerContext, 'companyId' | 'agentId' | 'companyHasComputer' | 'agentHasComputer'>,
  deps: Pick<LifecycleDeps, 'store' | 'hostClient' | 'now'>,
): Promise<{ destroyed: boolean; sessionId?: string; hostError?: string }> {
  assertComputerGates(ctx);
  const session = await deps.store.findActiveByAgent(ctx.agentId);
  if (!session) return { destroyed: false };

  let hostError: string | undefined;
  try {
    await deps.hostClient.stopAndRemove(session.containerName);
  } catch (err) {
    hostError = err instanceof Error ? err.message : String(err);
  }
  const now = deps.now?.() ?? new Date();
  await deps.store.update(session.id, { status: 'destroyed', destroyedAt: now, updatedAt: now });
  return { destroyed: true, sessionId: session.id, ...(hostError ? { hostError } : {}) };
}

/** Touch lastActivityAt (called by input actions so idle GC has data later). */
export async function touchSession(
  sessionId: string,
  deps: Pick<LifecycleDeps, 'store' | 'now'>,
): Promise<void> {
  const now = deps.now?.() ?? new Date();
  await deps.store.update(sessionId, { lastActivityAt: now, updatedAt: now });
}

export { GateError };
