import http from 'node:http';
import { db, agents, routines } from '@tourbillon/db';
import { eq } from 'drizzle-orm';
import { createTraceLogger, type HeartbeatJobData } from '@tourbillon/shared';
import { syncAgentTimerSchedule, syncRoutineSchedule, deleteRoutineSchedule } from '@tourbillon/mastra';
import { startWake, sweepStaleHeartbeatRuns, forceKillHeartbeat } from './wake-runner';

const tracer = createTraceLogger('wake-server', {});

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function authorize(req: http.IncomingMessage): boolean {
  const expected = process.env.SCHEDULER_API_KEY;
  if (!expected) return false;
  const auth = req.headers.authorization ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return token === expected;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * Lightweight HTTP endpoint so the web app can trigger wakes and sync schedules
 * without BullMQ. Default: SCHEDULER_WAKE_PORT=3003
 */
export function startWakeServer(): http.Server {
  const port = parseInt(process.env.SCHEDULER_WAKE_PORT ?? '3003', 10);

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        json(res, 200, { ok: true });
        return;
      }

      if (!authorize(req)) {
        json(res, 401, { error: 'unauthorized' });
        return;
      }

      if (req.method === 'POST' && req.url === '/internal/wake') {
        const raw = await readBody(req);
        const wake = JSON.parse(raw) as HeartbeatJobData;
        if (!wake.agentId || !wake.companyId || !wake.wakeReason) {
          json(res, 400, { error: 'agentId, companyId, wakeReason required' });
          return;
        }
        if (!wake.invocationSource) {
          wake.invocationSource = wake.wakeReason;
        }

        // Create heartbeat_runs first, return real runId; LLM work continues in background.
        const started = await startWake(wake);
        if (started.status === 'started') {
          void started.done.catch((err) => {
            tracer.error('async wake failed', {
              agentId: wake.agentId,
              runId: started.runId,
              error: err instanceof Error ? err.message : String(err),
            });
          });
          json(res, 202, {
            accepted: true,
            agentId: wake.agentId,
            runId: started.runId,
          });
          return;
        }

        json(res, started.status === 'queued' ? 202 : 409, {
          accepted: started.status === 'queued',
          agentId: wake.agentId,
          runId: started.runId || undefined,
          status: started.status,
          error: started.errorText,
        });
        return;
      }

      if (req.method === 'POST' && req.url === '/internal/schedules/sync-agent') {
        const raw = await readBody(req);
        const body = JSON.parse(raw) as { agentId?: string };
        if (!body.agentId) {
          json(res, 400, { error: 'agentId required' });
          return;
        }
        const agent = await db.query.agents.findFirst({ where: eq(agents.id, body.agentId) });
        if (!agent) {
          json(res, 404, { error: 'agent not found' });
          return;
        }
        const scheduleId = await syncAgentTimerSchedule(agent);
        json(res, 200, { scheduleId });
        return;
      }

      if (req.method === 'POST' && req.url === '/internal/schedules/sync-routine') {
        const raw = await readBody(req);
        const body = JSON.parse(raw) as { routineId?: string; delete?: boolean };
        if (!body.routineId) {
          json(res, 400, { error: 'routineId required' });
          return;
        }
        if (body.delete) {
          await deleteRoutineSchedule(body.routineId);
          json(res, 200, { deleted: true });
          return;
        }
        const routine = await db.query.routines.findFirst({ where: eq(routines.id, body.routineId) });
        if (!routine) {
          json(res, 404, { error: 'routine not found' });
          return;
        }
        const scheduleId = await syncRoutineSchedule(routine);
        if (scheduleId !== routine.mastraScheduleId) {
          await db
            .update(routines)
            .set({ mastraScheduleId: scheduleId, updatedAt: new Date() })
            .where(eq(routines.id, routine.id));
        }
        json(res, 200, { scheduleId });
        return;
      }

      if (req.method === 'POST' && req.url === '/internal/sweep-stale') {
        const n = await sweepStaleHeartbeatRuns();
        json(res, 200, { swept: n });
        return;
      }

      if (req.method === 'POST' && req.url?.startsWith('/internal/force-kill/')) {
        const runId = req.url.slice('/internal/force-kill/'.length);
        if (!runId) {
          json(res, 400, { error: 'runId required' });
          return;
        }
        const raw = await readBody(req);
        const body = JSON.parse(raw) as { companyId?: string };
        if (!body.companyId) {
          json(res, 400, { error: 'companyId required' });
          return;
        }
        const result = await forceKillHeartbeat(runId, body.companyId);
        if (!result.success) {
          const status = result.errorText === 'Run already finished' ? 409 : 404;
          tracer.info('force-kill attempt', { runId, status, hadController: result.hadController });
          json(res, status, {
            error: result.errorText,
          });
          return;
        }
        tracer.info('force-kill attempt', { runId, status: 200, hadController: result.hadController });
        json(res, 200, { killed: true, hadController: result.hadController });
        return;
      }

      json(res, 404, { error: 'not found' });
    } catch (err) {
      tracer.error('wake server error', {
        error: err instanceof Error ? err.message : String(err),
      });
      json(res, 500, { error: 'internal error' });
    }
  });

  server.listen(port, () => {
    tracer.info('wake server listening', { port });
  });

  return server;
}

export function startStaleSweepInterval(): ReturnType<typeof setInterval> {
  const intervalMs = 30_000;
  const handle = setInterval(() => {
    void sweepStaleHeartbeatRuns()
      .then((n) => {
        if (n > 0) tracer.info('swept stale heartbeat runs', { count: n });
      })
      .catch((err) => {
        tracer.error('stale sweep failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }, intervalMs);
  tracer.info('stale sweep started', { intervalMs });
  return handle;
}
