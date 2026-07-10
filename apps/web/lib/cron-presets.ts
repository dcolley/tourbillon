export const HEARTBEAT_CRON_PRESETS = [
  { id: 'hourly', label: 'Every hour', cron: '0 * * * *' },
  { id: 'daily-9', label: 'Every day at 9:00', cron: '0 9 * * *' },
  { id: 'weekdays-9', label: 'Weekdays at 9:00', cron: '0 9 * * 1-5' },
  { id: 'monday-9', label: 'Every Monday at 9:00', cron: '0 9 * * 1' },
  { id: 'custom', label: 'Custom', cron: '' },
] as const;

export type HeartbeatCronPresetId = (typeof HEARTBEAT_CRON_PRESETS)[number]['id'];

export function presetIdForCron(cron: string): HeartbeatCronPresetId {
  const trimmed = cron.trim();
  const match = HEARTBEAT_CRON_PRESETS.find((preset) => preset.id !== 'custom' && preset.cron === trimmed);
  return match?.id ?? 'custom';
}

export function cronForPreset(presetId: string): string {
  return HEARTBEAT_CRON_PRESETS.find((preset) => preset.id === presetId)?.cron ?? '';
}

export function presetLabel(presetId: string): string {
  return HEARTBEAT_CRON_PRESETS.find((preset) => preset.id === presetId)?.label ?? 'Custom';
}
