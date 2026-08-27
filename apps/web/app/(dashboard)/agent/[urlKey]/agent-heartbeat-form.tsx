'use client';

import { useActionState, useMemo, useState } from 'react';
import cronstrue from 'cronstrue';
import type { AgentRuntimeConfig } from '@tourbillon/shared/types';
import { inferHeartbeatScheduleMode } from '@tourbillon/shared/heartbeat-schedule-mode';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@/components/ui/select';
import {
  HEARTBEAT_CRON_PRESETS,
  cronForPreset,
  presetIdForCron,
  presetLabel,
} from '@/lib/cron-presets';
import type { ActionResult } from '@/lib/action-result';
import { useActionToast } from '@/hooks/use-action-toast';
import { ActionSubmitButton } from '@/components/action-form';

interface AgentHeartbeatFormProps {
  agentId: string;
  urlKey: string;
  heartbeat: AgentRuntimeConfig['heartbeat'];
  timeout: AgentRuntimeConfig['timeout'];
  updateHeartbeatConfig: (
    prev: ActionResult | null,
    formData: FormData,
  ) => Promise<ActionResult>;
}

export function AgentHeartbeatForm({
  agentId,
  urlKey,
  heartbeat,
  timeout,
  updateHeartbeatConfig,
}: AgentHeartbeatFormProps) {
  const [state, formAction] = useActionState(updateHeartbeatConfig, null);
  useActionToast(state);

  const initialMode = inferHeartbeatScheduleMode(heartbeat);
  const initialCron = (heartbeat.cronExpression ?? '').trim();
  const initialPresetId = presetIdForCron(initialCron);

  const [scheduleMode, setScheduleMode] = useState<'interval' | 'cron'>(initialMode);
  const [presetId, setPresetId] = useState(initialPresetId);
  const [customCron, setCustomCron] = useState(
    initialMode === 'cron' && initialPresetId === 'custom' ? initialCron : '',
  );
  const [timezone, setTimezone] = useState(heartbeat.timezone ?? 'UTC');
  const [intervalSec, setIntervalSec] = useState(
    heartbeat.intervalSec > 0 ? String(heartbeat.intervalSec) : '300',
  );
  const [maxSteps, setMaxSteps] = useState(
    heartbeat.maxSteps !== undefined ? String(heartbeat.maxSteps) : '30',
  );
  const [timeoutSec, setTimeoutSec] = useState(
    String(timeout?.heartbeatSec ?? 300),
  );

  const cronExpression = useMemo(() => {
    if (scheduleMode !== 'cron') return '';
    if (presetId === 'custom') return customCron.trim();
    return cronForPreset(presetId);
  }, [scheduleMode, presetId, customCron]);

  const cronPreview = useMemo(() => {
    if (scheduleMode !== 'cron' || !cronExpression) return null;
    try {
      return cronstrue.toString(cronExpression);
    } catch {
      return null;
    }
  }, [scheduleMode, cronExpression]);

  return (
    <form action={formAction} className="space-y-4 text-sm">
      <input type="hidden" name="agentId" value={agentId} />
      <input type="hidden" name="urlKey" value={urlKey} />
      <input type="hidden" name="scheduleMode" value={scheduleMode} />
      <input type="hidden" name="cronExpression" value={cronExpression} />

      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          name="heartbeatEnabled"
          defaultChecked={heartbeat.enabled}
          className="rounded border-input"
        />
        <span>Enable automatic heartbeats</span>
      </label>

      <fieldset className="space-y-2">
        <legend className="text-muted-foreground text-xs font-medium">Schedule type</legend>
        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              name="scheduleModePicker"
              value="interval"
              checked={scheduleMode === 'interval'}
              onChange={() => setScheduleMode('interval')}
            />
            <span>Interval</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              name="scheduleModePicker"
              value="cron"
              checked={scheduleMode === 'cron'}
              onChange={() => setScheduleMode('cron')}
            />
            <span>Cron schedule</span>
          </label>
        </div>
      </fieldset>

      {scheduleMode === 'interval' ? (
        <div>
          <label htmlFor="intervalSec" className="text-muted-foreground block mb-1">
            Interval (seconds)
          </label>
          <input
            id="intervalSec"
            name="intervalSec"
            type="number"
            min={60}
            step={60}
            value={intervalSec}
            onChange={(event) => setIntervalSec(event.target.value)}
            className="w-32 rounded-md border border-input bg-background px-3 py-1.5 text-sm"
          />
          <p className="text-xs text-muted-foreground mt-1">Minimum 60s. Requires workers running.</p>
        </div>
      ) : (
        <div className="space-y-3">
          <div>
            <label className="text-muted-foreground block mb-1">Preset</label>
            <Select
              value={presetId}
              onValueChange={(value) => {
                if (!value) return;
                setPresetId(value as typeof presetId);
              }}
            >
              <SelectTrigger className="h-8 w-full max-w-md">
                <span>{presetLabel(presetId)}</span>
              </SelectTrigger>
              <SelectContent>
                {HEARTBEAT_CRON_PRESETS.map((preset) => (
                  <SelectItem key={preset.id} value={preset.id} label={preset.label}>
                    {preset.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {presetId === 'custom' && (
            <div>
              <label htmlFor="customCron" className="text-muted-foreground block mb-1">
                Cron expression
              </label>
              <input
                id="customCron"
                type="text"
                value={customCron}
                onChange={(event) => setCustomCron(event.target.value)}
                placeholder="0 9 * * 1"
                className="w-full max-w-md rounded-md border border-input bg-background px-3 py-1.5 font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground mt-1">5-field Unix cron (minute hour day month weekday).</p>
            </div>
          )}

          <div>
            <label htmlFor="timezone" className="text-muted-foreground block mb-1">
              Timezone
            </label>
            <input
              id="timezone"
              name="timezone"
              type="text"
              value={timezone}
              onChange={(event) => setTimezone(event.target.value)}
              className="w-full max-w-md rounded-md border border-input bg-background px-3 py-1.5 text-sm"
            />
          </div>

          {cronPreview ? (
            <p className="text-xs text-muted-foreground">{cronPreview}</p>
          ) : cronExpression ? (
            <p className="text-xs text-destructive">Invalid cron expression.</p>
          ) : null}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="maxSteps" className="text-muted-foreground block mb-1">
            Max steps per heartbeat
          </label>
          <input
            id="maxSteps"
            name="maxSteps"
            type="number"
            min={1}
            step={1}
            value={maxSteps}
            onChange={(event) => setMaxSteps(event.target.value)}
            className="w-32 rounded-md border border-input bg-background px-3 py-1.5 text-sm"
          />
          <p className="text-xs text-muted-foreground mt-1">
            Maximum model steps per heartbeat. Default 30. Aborts when exceeded.
          </p>
        </div>

        <div>
          <label htmlFor="timeoutSec" className="text-muted-foreground block mb-1">
            Timeout (seconds)
          </label>
          <input
            id="timeoutSec"
            name="timeoutSec"
            type="number"
            min={60}
            step={1}
            value={timeoutSec}
            onChange={(event) => setTimeoutSec(event.target.value)}
            className="w-32 rounded-md border border-input bg-background px-3 py-1.5 text-sm"
          />
          <p className="text-xs text-muted-foreground mt-1">
            Wall-clock abort for one wake. Minimum 60s. Requires workers running.
          </p>
        </div>
      </div>

      <ActionSubmitButton label="Save heartbeat settings" />
    </form>
  );
}
