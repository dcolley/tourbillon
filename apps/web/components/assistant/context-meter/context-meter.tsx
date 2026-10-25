'use client';

/**
 * CTX-1: context meter beside the composer's model picker — `~12.4k / 128k` and a thin bar.
 *
 * The limit is the chat context budget of the thread's model; the used figure is an estimate
 * (see lib/assistant/context-meter.ts). The tooltip says where trimming / Observational Memory
 * kick in. Reloads when `refreshKey` changes (thread open, after each turn, model change).
 */
import * as React from 'react';
import {
  contextMeterLabel,
  contextMeterRatio,
  contextMeterTitle,
  type ThreadContextMeter,
} from '@/lib/assistant/context-meter';
import { createContextMeterController, type ContextMeterController, type ContextMeterSnapshot } from './context-meter-controller';

const BAR_CLASS: Record<ThreadContextMeter['level'], string> = {
  ok: 'bg-muted-foreground/60',
  near: 'bg-amber-500',
  over: 'bg-destructive',
};

export function ContextMeterView({ snapshot }: { snapshot: ContextMeterSnapshot }) {
  const meter = snapshot.meter;
  if (!meter) {
    return snapshot.status === 'loading' ? (
      <span className="text-xs text-muted-foreground" data-context-meter="loading" aria-hidden>
        …
      </span>
    ) : null;
  }
  const pct = Math.round(contextMeterRatio(meter) * 100);
  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs tabular-nums text-muted-foreground"
      data-context-meter={meter.level}
      data-limit-source={meter.limitSource}
      title={contextMeterTitle(meter)}
      role="meter"
      aria-label="Context used"
      aria-valuemin={0}
      aria-valuemax={meter.limitTokens}
      aria-valuenow={meter.usedTokens}
      aria-valuetext={`${contextMeterLabel(meter)} tokens (estimate)`}
    >
      <span className="relative h-1 w-10 overflow-hidden rounded-full bg-muted" aria-hidden>
        <span className={`absolute inset-y-0 left-0 ${BAR_CLASS[meter.level]}`} style={{ width: `${pct}%` }} />
      </span>
      <span>{contextMeterLabel(meter)}</span>
    </span>
  );
}

/** Meter bound to one thread; `refreshKey` null keeps the last value (e.g. while a run streams). */
export function ContextMeter({
  agentId,
  threadId,
  refreshKey,
  controller: provided,
}: {
  agentId: string;
  threadId: string;
  refreshKey?: string | null;
  controller?: ContextMeterController;
}) {
  const controller = React.useMemo(
    () => provided ?? createContextMeterController({ agentId, threadId }),
    [provided, agentId, threadId],
  );
  const snapshot = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  // Load on open (even mid-run), then again whenever a non-null refreshKey changes.
  const last = React.useRef<{ controller: ContextMeterController; key: string | null | undefined } | null>(null);
  React.useEffect(() => {
    const prev = last.current;
    if (prev?.controller === controller && (refreshKey === null || refreshKey === prev.key)) return;
    last.current = { controller, key: refreshKey };
    void controller.load();
  }, [controller, refreshKey]);
  return <ContextMeterView snapshot={snapshot} />;
}
