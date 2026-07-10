import type { AgentRuntimeConfig, HeartbeatScheduleMode } from './types';

export type { HeartbeatScheduleMode } from './types';

export type HeartbeatConfig = AgentRuntimeConfig['heartbeat'];

export function inferHeartbeatScheduleMode(hb: HeartbeatConfig): HeartbeatScheduleMode {
  if (hb.scheduleMode === 'cron' || hb.scheduleMode === 'interval') {
    return hb.scheduleMode;
  }
  if ((hb.cronExpression ?? '').trim()) return 'cron';
  return 'interval';
}
