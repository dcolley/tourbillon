import type { SessionStatus } from './constants';

/** Registry row shape (mirrors company_computer_sessions in @tourbillon/db). */
export interface ComputerSession {
  id: string;
  companyId: string;
  agentId: string;
  agentUrlKey: string;
  containerName: string;
  image: string;
  vncPort: number;
  status: SessionStatus;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  destroyedAt: Date | null;
  lastActivityAt: Date | null;
  /** Optional takeover fields (Board watch/takeover is Slice 2+; columns exist now). */
  takeoverStatus: 'watching' | 'taken_over' | null;
  takeoverUserId: string | null;
}

/** Persistent session registry. Web injects a Drizzle-backed store; tests use the
 *  in-memory implementation from ./session-registry. */
export interface SessionStore {
  findActiveByAgent(agentId: string): Promise<ComputerSession | null>;
  getById(sessionId: string): Promise<ComputerSession | null>;
  insert(session: ComputerSession): Promise<ComputerSession>;
  update(
    sessionId: string,
    patch: Partial<Omit<ComputerSession, 'id' | 'companyId' | 'agentId'>>,
  ): Promise<ComputerSession | null>;
  /** Ports held by ALL non-destroyed sessions on this HOST (host-wide, not
   *  company-scoped: every seat binds a port on the same host — #282 B2). */
  listActivePorts(): Promise<number[]>;
  /** Host-wide count of non-destroyed seats (MAX_ACTIVE_SEATS cap input). */
  countActiveSessions(): Promise<number>;
}

/** A bind mount for one per-agent container. */
export interface ContainerMount {
  /** Host path (always under /opt/tourbillon-company-{companyId}/…). */
  source: string;
  /** Container path. */
  target: string;
}

/** Everything the HostClient needs to start one agent seat. */
export interface ContainerSpec {
  name: string;
  image: string;
  /** Container-side KasmVNC port (6901). */
  containerPort: number;
  /** Host port allocated from PORT_BASE upward. */
  hostPort: number;
  env: Record<string, string>;
  mounts: ContainerMount[];
  shmSizeBytes: number;
  memoryBytes: number;
  nanoCpus: number;
}

/**
 * Host provision boundary. Slice 1 ships only the dry-run implementation; the web
 * app can inject a real one later (Ops ensure scripts behind CC_ALLOW_START=1).
 */
export interface HostClient {
  /** Create the canonical host directories (idempotent). */
  ensureDirs(dirs: string[]): Promise<void>;
  /** Start (or adopt) the container described by spec; returns the live session. */
  startContainer(spec: ContainerSpec): Promise<{ containerId: string; startedAt: Date }>;
  /** Stop and remove the container. Missing container is NOT an error. */
  stopAndRemove(containerName: string): Promise<void>;
  /** Cheap liveness probe for getSession. */
  healthCheck(containerName: string): Promise<boolean>;
  /** Run a command inside the seat (xdotool etc. — Slice 2 impl via docker exec). */
  execInContainer(containerName: string, argv: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /** Capture the seat's screen as PNG. */
  screenshot(containerName: string): Promise<{ imageBase64: string; width: number; height: number }>;
  /** Send a pointer/keyboard event batch to the seat (xdotool batch — Slice 2 impl). */
  sendInput(
    containerName: string,
    input: { kind: 'click'; x: number; y: number; button: 'left' | 'right' | 'middle' } | { kind: 'type'; text: string },
  ): Promise<{ success: boolean }>;
}

/** Errors the API layer maps to stable HTTP codes. */
export class GateError extends Error {
  constructor(
    readonly code: 'company_not_provisioned' | 'agent_no_computer',
    message: string,
  ) {
    super(message);
    this.name = 'GateError';
  }
}

export class HostStartRefusedError extends Error {
  readonly code = 'host_start_refused';
  constructor(message: string) {
    super(message);
    this.name = 'HostStartRefusedError';
  }
}

export class HostBackendUnavailableError extends Error {
  readonly code = 'ops_contract_missing';
  constructor(message: string) {
    super(message);
    this.name = 'HostBackendUnavailableError';
  }
}

/** Host-wide seat cap (MAX_ACTIVE_SEATS) reached — no new seat until one is destroyed. */
export class SeatCapExceededError extends Error {
  readonly code = 'seat_cap_exceeded';
  constructor(message: string) {
    super(message);
    this.name = 'SeatCapExceededError';
  }
}

/** Context every lifecycle/tool call carries (from the run token / route auth). */
export interface ComputerContext {
  companyId: string;
  agentId: string;
  agentUrlKey: string;
  companySlug: string | null;
  /** Denormalised gate flags, read by the caller (route) from the DB. */
  companyHasComputer: boolean;
  agentHasComputer: boolean;
}
