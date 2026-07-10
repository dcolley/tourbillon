import { Cron } from 'croner';
import type { HeartbeatScheduleMode } from './types';
import {
  inferHeartbeatScheduleMode,
  type HeartbeatConfig,
} from './heartbeat-schedule-mode';

export type { HeartbeatScheduleMode } from './types';
export type { HeartbeatConfig } from './heartbeat-schedule-mode';
export { inferHeartbeatScheduleMode } from './heartbeat-schedule-mode';

export interface ResolvedHeartbeatSchedule {
  active: boolean;
  cron: string;
  timezone?: string;
  scheduleMode: HeartbeatScheduleMode;
  metadata: Record<string, unknown>;
}

/** Convert intervalSec to a 5-field cron. Minimum interval: 60 seconds. */
export function intervalSecToCron(intervalSec: number): string {
  const sec = Math.max(60, Math.floor(intervalSec));
  if (sec < 3600) {
    const minutes = Math.max(1, Math.floor(sec / 60));
    return minutes === 1 ? '* * * * *' : `*/${minutes} * * * *`;
  }
  const hours = Math.min(23, Math.max(1, Math.floor(sec / 3600)));
  return hours === 1 ? '0 * * * *' : `0 */${hours} * * *`;
}

export function validateCronExpression(expr: string): string | null {
  const trimmed = expr.trim();
  if (!trimmed) return 'Cron expression is required.';
  try {
    new Cron(trimmed);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : 'Invalid cron expression.';
  }
}

export function validateHeartbeatSchedule(hb: HeartbeatConfig): string | null {
  if (!hb.enabled) return null;

  const mode = inferHeartbeatScheduleMode(hb);
  if (mode === 'interval') {
    if (!Number.isFinite(hb.intervalSec) || hb.intervalSec < 60) {
      return 'Automatic heartbeats require an interval of at least 60 seconds.';
    }
    return null;
  }

  return validateCronExpression(hb.cronExpression ?? '');
}

export function resolveHeartbeatSchedule(
  hb: HeartbeatConfig | null | undefined,
): ResolvedHeartbeatSchedule {
  const config: HeartbeatConfig = hb ?? {
    enabled: false,
    intervalSec: 0,
    wakeOnAssignment: true,
    wakeOnDemand: true,
    wakeOnAutomation: false,
  };
  const mode = inferHeartbeatScheduleMode(config);

  if (!config.enabled) {
    return { active: false, cron: '', scheduleMode: mode, metadata: {} };
  }

  if (mode === 'interval') {
    const intervalSec = config.intervalSec ?? 0;
    if (intervalSec < 60) {
      return {
        active: false,
        cron: '',
        scheduleMode: mode,
        metadata: { scheduleMode: mode, intervalSec },
      };
    }
    return {
      active: true,
      cron: intervalSecToCron(intervalSec),
      scheduleMode: mode,
      metadata: { scheduleMode: mode, intervalSec },
    };
  }

  const cronExpression = (config.cronExpression ?? '').trim();
  const timezone = (config.timezone ?? 'UTC').trim() || 'UTC';
  if (!cronExpression || validateCronExpression(cronExpression)) {
    return {
      active: false,
      cron: '',
      scheduleMode: mode,
      timezone,
      metadata: { scheduleMode: mode, cronExpression, timezone },
    };
  }

  return {
    active: true,
    cron: cronExpression,
    timezone,
    scheduleMode: mode,
    metadata: { scheduleMode: mode, cronExpression, timezone },
  };
}

export function normalizeHeartbeatConfig(hb: HeartbeatConfig): HeartbeatConfig {
  const mode = inferHeartbeatScheduleMode(hb);
  if (mode === 'interval') {
    return {
      ...hb,
      scheduleMode: 'interval',
      intervalSec: hb.intervalSec ?? 0,
      cronExpression: undefined,
      timezone: undefined,
    };
  }
  return {
    ...hb,
    scheduleMode: 'cron',
    intervalSec: 0,
    cronExpression: (hb.cronExpression ?? '').trim(),
    timezone: (hb.timezone ?? 'UTC').trim() || 'UTC',
  };
}
