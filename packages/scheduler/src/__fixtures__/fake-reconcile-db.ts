/**
 * #202 ACCEPT softs (S1): a minimal fake ChatTaskDb that drives the REAL
 * reconcileStaleChatTaskRuns path (listStaleChatTaskRuns + finishChatTaskRun, both from
 * @tourbillon/db) without a database. It exists so the scheduler-side WIRING of
 * `resolveMaxAttempts` — in startup-sweep.ts's reconcileChatTaskRunsOnStartup and in
 * task-runner.ts's sweepStaleChatTaskRuns — is under test: the db package's own reconcile
 * tests pass their own copy of the resolver, so only these scheduler tests fail when the
 * production call sites drop it.
 *
 * Shapes driven (the exact drizzle chains the two query functions build):
 *   select → from → leftJoin → where → orderBy → limit   (stale list)
 *   select → from → where → limit                        (finish existence read)
 *   update → set   → where → returning                   (finish settle write)
 */
import type { ChatTaskDb, StaleChatTaskRunRow } from '@tourbillon/db';

export interface SettledWrite {
  status: string;
  notes: string | null;
  completedAt: Date | null;
}

export function fakeReconcileDb(opts: {
  /** The rows listStaleChatTaskRuns "finds" — one per crashed Run Task. */
  stale: StaleChatTaskRunRow[];
  /** notes as the finishChatTaskRun existence read sees them (default: a note seed). */
  existingNotes?: Record<string, string | null>;
}): { db: ChatTaskDb; settled: SettledWrite[] } {
  const settled: SettledWrite[] = [];
  let selectCalls = 0;

  const chain = (rows: unknown[]): Record<string, unknown> => {
    const api: Record<string, unknown> = {};
    for (const m of ['from', 'leftJoin', 'innerJoin', 'where', 'orderBy', 'limit']) {
      api[m] = () => api;
    }
    api.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(res, rej);
    return api;
  };

  const database = {
    select: () => {
      selectCalls += 1;
      // Call 1 is the stale list; later calls are finishChatTaskRun's existence reads,
      // one per settled row, in reconcile order.
      if (selectCalls === 1) return chain(opts.stale);
      const row = opts.stale[selectCalls - 2];
      if (!row) return chain([]); // vanished between read and settle → finish returns null
      const notes = opts.existingNotes?.[row.taskId] ?? 'pre-existing notes';
      return chain([{ id: row.taskId, status: 'in_progress', notes }]);
    },
    update: () => {
      const api: Record<string, unknown> = {};
      let setVal: Record<string, unknown> = {};
      api.set = (v: Record<string, unknown>) => {
        setVal = v;
        return api;
      };
      api.where = () => api;
      api.returning = async () => {
        settled.push({
          status: String(setVal.status),
          notes: (setVal.notes as string | null) ?? null,
          completedAt: (setVal.completedAt as Date | null) ?? null,
        });
        return [{ ...setVal }];
      };
      return api;
    },
  };

  return { db: database as unknown as ChatTaskDb, settled };
}

/** A stale-row seed with sensible crashed-run defaults. */
export function staleRow(over: Partial<StaleChatTaskRunRow> = {}): StaleChatTaskRunRow {
  return {
    taskId: 't1',
    companyId: 'c1',
    agentId: 'a1',
    title: 'Crashed run',
    attempts: 1,
    runnerLastRunId: 'run-dead',
    companySettings: null,
    ...over,
  };
}
