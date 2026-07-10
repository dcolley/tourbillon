import {
  DEFAULT_RUNTIME_CONFIG,
  inferHeartbeatScheduleMode,
  resolveHeartbeatSchedule,
  type AgentRuntimeConfig,
  type HeartbeatScheduleMode,
} from '@tourbillon/shared';

export interface AgentHeartbeatSummary {
  timerEnabled: boolean;
  intervalSec: number;
  cronExpression?: string;
  scheduleMode: HeartbeatScheduleMode;
  label: string;
  misconfigured: boolean;
}

export function getAgentHeartbeatSummary(runtimeConfig: unknown): AgentHeartbeatSummary {
  const config = (runtimeConfig ?? DEFAULT_RUNTIME_CONFIG) as AgentRuntimeConfig;
  const heartbeat = config.heartbeat ?? DEFAULT_RUNTIME_CONFIG.heartbeat;
  const timerEnabled = heartbeat.enabled ?? false;
  const scheduleMode = inferHeartbeatScheduleMode(heartbeat);
  const intervalSec = heartbeat.intervalSec ?? 0;
  const cronExpression = heartbeat.cronExpression?.trim() || undefined;
  const resolved = resolveHeartbeatSchedule(heartbeat);

  if (!timerEnabled) {
    return {
      timerEnabled: false,
      intervalSec,
      cronExpression,
      scheduleMode,
      label: 'Timer off',
      misconfigured: false,
    };
  }

  if (!resolved.active) {
    return {
      timerEnabled: true,
      intervalSec,
      cronExpression,
      scheduleMode,
      label: 'Timer misconfigured',
      misconfigured: true,
    };
  }

  if (scheduleMode === 'cron' && cronExpression) {
    return {
      timerEnabled: true,
      intervalSec,
      cronExpression,
      scheduleMode,
      label: `Cron: ${cronExpression}`,
      misconfigured: false,
    };
  }

  if (intervalSec <= 0) {
    return {
      timerEnabled: true,
      intervalSec,
      cronExpression,
      scheduleMode,
      label: 'Timer on',
      misconfigured: false,
    };
  }

  if (intervalSec % 3600 === 0) {
    const hours = intervalSec / 3600;
    return {
      timerEnabled: true,
      intervalSec,
      cronExpression,
      scheduleMode,
      label: `Every ${hours}h`,
      misconfigured: false,
    };
  }

  if (intervalSec % 60 === 0) {
    const minutes = intervalSec / 60;
    return {
      timerEnabled: true,
      intervalSec,
      cronExpression,
      scheduleMode,
      label: `Every ${minutes}m`,
      misconfigured: false,
    };
  }

  return {
    timerEnabled: true,
    intervalSec,
    cronExpression,
    scheduleMode,
    label: `Every ${intervalSec}s`,
    misconfigured: false,
  };
}
