/**
 * Drizzle-backed adapters for @tourbillon/company-computer (web side).
 *
 * Slice 1 host policy: the dry-run HostClient is the ONLY client we ever return —
 * real seats need the Ops ensure contract + CC_ALLOW_START=1 (Slice 2). Tests inject
 * their own store/host client directly into the package lifecycle functions.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db, companyComputerSessions, companies, agents } from '@tourbillon/db';
import type {
  ComputerSession,
  HostClient,
  SessionStore,
} from '@tourbillon/company-computer';
import { createDryRunHostClient } from '@tourbillon/company-computer';
import type { ComputerFlagsStore } from '@tourbillon/company-computer/settings';

const ACTIVE_STATUSES = ['starting', 'running', 'stopped'] as const;

function rowToSession(row: typeof companyComputerSessions.$inferSelect): ComputerSession {
  return {
    id: row.id,
    companyId: row.companyId,
    agentId: row.agentId,
    agentUrlKey: row.agentUrlKey,
    containerName: row.containerName,
    image: row.image,
    vncPort: row.vncPort,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    startedAt: row.startedAt,
    destroyedAt: row.destroyedAt,
    lastActivityAt: row.lastActivityAt,
    takeoverStatus: row.takeoverStatus,
    takeoverUserId: row.takeoverUserId,
  };
}

export function createDrizzleSessionStore(): SessionStore {
  return {
    async findActiveByAgent(agentId: string): Promise<ComputerSession | null> {
      const row = await db.query.companyComputerSessions.findFirst({
        where: and(
          eq(companyComputerSessions.agentId, agentId),
          inArray(companyComputerSessions.status, [...ACTIVE_STATUSES]),
        ),
        orderBy: (t, { desc }) => [desc(t.createdAt)],
      });
      return row ? rowToSession(row) : null;
    },
    async getById(sessionId: string): Promise<ComputerSession | null> {
      const row = await db.query.companyComputerSessions.findFirst({
        where: eq(companyComputerSessions.id, sessionId),
      });
      return row ? rowToSession(row) : null;
    },
    async insert(session: ComputerSession): Promise<ComputerSession> {
      await db.insert(companyComputerSessions).values({
        id: session.id,
        companyId: session.companyId,
        agentId: session.agentId,
        agentUrlKey: session.agentUrlKey,
        containerName: session.containerName,
        image: session.image,
        vncPort: session.vncPort,
        status: session.status,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        startedAt: session.startedAt,
        destroyedAt: session.destroyedAt,
        lastActivityAt: session.lastActivityAt,
        takeoverStatus: session.takeoverStatus,
        takeoverUserId: session.takeoverUserId,
      });
      return session;
    },
    async update(sessionId, patch): Promise<ComputerSession | null> {
      const updated = await db
        .update(companyComputerSessions)
        .set(patch)
        .where(eq(companyComputerSessions.id, sessionId))
        .returning();
      return updated[0] ? rowToSession(updated[0]) : null;
    },
    async listActivePorts(companyId: string): Promise<number[]> {
      const rows = await db
        .select({ vncPort: companyComputerSessions.vncPort })
        .from(companyComputerSessions)
        .where(
          and(
            eq(companyComputerSessions.companyId, companyId),
            inArray(companyComputerSessions.status, [...ACTIVE_STATUSES]),
          ),
        );
      return rows.map((r) => r.vncPort);
    },
    async countActiveSessions(): Promise<number> {
      const rows = await db
        .select({ id: companyComputerSessions.id })
        .from(companyComputerSessions)
        .where(inArray(companyComputerSessions.status, [...ACTIVE_STATUSES]));
      return rows.length;
    },
  };
}

/** Slice 1: always the dry-run client. Slice 2 swaps this for the Ops-backed one. */
export function getCompanyComputerHostClient(): HostClient {
  return createDryRunHostClient();
}

/** Settings-stub flag writes (companies.has_computer / agents.has_computer). */
export function createDrizzleComputerFlagsStore(): ComputerFlagsStore {
  return {
    async setCompanyHasComputer(companyId: string, value: boolean): Promise<void> {
      await db.update(companies).set({ hasComputer: value, updatedAt: new Date() }).where(eq(companies.id, companyId));
    },
    async setAgentHasComputer(agentId: string, value: boolean): Promise<void> {
      await db.update(agents).set({ hasComputer: value, updatedAt: new Date() }).where(eq(agents.id, agentId));
    },
  };
}
