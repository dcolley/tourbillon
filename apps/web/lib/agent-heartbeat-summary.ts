import { DEFAULT_RUNTIME_CONFIG, type AgentRuntimeConfig } from '@tourbillon/shared';

export interface AgentHeartbeatSummary {
  timerEnabled: boolean;
  intervalSec: number;
  label: string;
}

export function getAgentHeartbeatSummary(runtimeConfig: unknown): AgentHeartbeatSummary {
  const config = (runtimeConfig ?? DEFAULT_RUNTIME_CONFIG) as AgentRuntimeConfig;
  const timerEnabled = config.heartbeat?.enabled ?? false;
  const intervalSec = config.heartbeat?.intervalSec ?? 0;

  if (!timerEnabled) {
    return { timerEnabled: false, intervalSec, label: 'Timer off' };
  }

  if (intervalSec <= 0) {
    return { timerEnabled: true, intervalSec, label: 'Timer on' };
  }

  if (intervalSec % 3600 === 0) {
    const hours = intervalSec / 3600;
    return { timerEnabled: true, intervalSec, label: `Every ${hours}h` };
  }

  if (intervalSec % 60 === 0) {
    const minutes = intervalSec / 60;
    return { timerEnabled: true, intervalSec, label: `Every ${minutes}m` };
  }

  return { timerEnabled: true, intervalSec, label: `Every ${intervalSec}s` };
}
