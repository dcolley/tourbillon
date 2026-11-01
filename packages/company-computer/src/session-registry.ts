/**
 * Session registry — pure in-memory SessionStore for tests and dry-run use.
 * The web app injects a Drizzle-backed store (apps/web/lib/company-computer-host.ts).
 */
import type { ComputerSession, SessionStore } from './types';
import { SESSION_STATUSES, type SessionStatus } from './constants';

const ACTIVE_STATUSES: ReadonlySet<SessionStatus> = new Set(['starting', 'running', 'stopped']);

/** Test/dev store. Rows are cloned in/out so callers cannot mutate the registry. */
export class InMemorySessionStore implements SessionStore {
  private rows = new Map<string, ComputerSession>();
  private seq = 0;

  private clone(row: ComputerSession): ComputerSession {
    return { ...row };
  }

  /** Test helper: seed a row (bypasses insert bookkeeping). */
  seed(session: ComputerSession): void {
    this.rows.set(session.id, this.clone(session));
  }

  /** Test helper: every row regardless of status. */
  all(): ComputerSession[] {
    return [...this.rows.values()].map((r) => this.clone(r));
  }

  async findActiveByAgent(agentId: string): Promise<ComputerSession | null> {
    for (const row of this.rows.values()) {
      if (row.agentId === agentId && ACTIVE_STATUSES.has(row.status)) return this.clone(row);
    }
    return null;
  }

  async getById(sessionId: string): Promise<ComputerSession | null> {
    const row = this.rows.get(sessionId);
    return row ? this.clone(row) : null;
  }

  async insert(session: ComputerSession): Promise<ComputerSession> {
    if (!SESSION_STATUSES.includes(session.status)) {
      throw new Error(`unknown session status "${session.status}"`);
    }
    if (this.rows.has(session.id)) throw new Error(`session ${session.id} already exists`);
    this.seq += 1;
    this.rows.set(session.id, this.clone(session));
    return this.clone(session);
  }

  async update(
    sessionId: string,
    patch: Partial<Omit<ComputerSession, 'id' | 'companyId' | 'agentId'>>,
  ): Promise<ComputerSession | null> {
    const row = this.rows.get(sessionId);
    if (!row) return null;
    if (patch.status && !SESSION_STATUSES.includes(patch.status)) {
      throw new Error(`unknown session status "${patch.status}"`);
    }
    const next = { ...row, ...patch, id: row.id, companyId: row.companyId, agentId: row.agentId };
    this.rows.set(sessionId, next);
    return this.clone(next);
  }

  async listActivePorts(companyId: string): Promise<number[]> {
    const ports: number[] = [];
    for (const row of this.rows.values()) {
      if (row.companyId === companyId && ACTIVE_STATUSES.has(row.status)) ports.push(row.vncPort);
    }
    return ports;
  }

  async countActiveSessions(): Promise<number> {
    let n = 0;
    for (const row of this.rows.values()) {
      if (ACTIVE_STATUSES.has(row.status)) n += 1;
    }
    return n;
  }

  /** Deterministic ids for tests. */
  nextId(prefix = 'ccs'): string {
    return `${prefix}-${++this.seq}`;
  }
}
