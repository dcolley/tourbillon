import type { Job } from 'bullmq';
import { formatTrace, type TraceContext } from '@tourbillon/shared';

type TraceLevel = 'info' | 'warn' | 'error';

export function createJobTracer(scope: string, ctx: TraceContext, job?: Job) {
  const write = (level: TraceLevel, message: string, data?: Record<string, unknown>) => {
    const line = formatTrace(scope, ctx, message, data);
    if (level === 'info') console.log(line);
    else if (level === 'warn') console.warn(line);
    else console.error(line);

    if (job) {
      job.log(line).catch(() => {
        // BullMQ log sink can fail if the job was removed; ignore.
      });
    }
  };

  return {
    info: (message: string, data?: Record<string, unknown>) => write('info', message, data),
    warn: (message: string, data?: Record<string, unknown>) => write('warn', message, data),
    error: (message: string, data?: Record<string, unknown>) => write('error', message, data),
    child: (extra: Partial<TraceContext>) => createJobTracer(scope, { ...ctx, ...extra }, job),
  };
}
