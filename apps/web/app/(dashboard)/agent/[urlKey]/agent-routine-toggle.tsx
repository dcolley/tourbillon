'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import type { ActionResult } from '@/lib/action-result';
import { useActionToast } from '@/hooks/use-action-toast';
import { ActionSubmitButton } from '@/components/action-form';

export function AgentRoutineToggle({
  routineId,
  agentId,
  urlKey,
  initiallyEnabled,
  toggleRoutine,
}: {
  routineId: string;
  agentId: string;
  urlKey: string;
  initiallyEnabled: boolean;
  toggleRoutine: (prev: ActionResult | null, formData: FormData) => Promise<ActionResult>;
}) {
  const [enabled, setEnabled] = useState(initiallyEnabled);
  const [state, formAction] = useActionState(toggleRoutine, null);
  useActionToast(state);
  const lastSuccess = useRef<ActionResult | null>(null);

  useEffect(() => {
    if (!state?.ok || state === lastSuccess.current) return;
    lastSuccess.current = state;
    setEnabled((prev) => !prev);
  }, [state]);

  return (
    <form action={formAction}>
      <input type="hidden" name="routineId" value={routineId} />
      <input type="hidden" name="agentId" value={agentId} />
      <input type="hidden" name="urlKey" value={urlKey} />
      <input type="hidden" name="enabled" value={enabled ? 'false' : 'true'} />
      <ActionSubmitButton
        label={enabled ? 'Enabled' : 'Disabled'}
        pendingLabel="…"
        className={`rounded-full px-2.5 py-1 text-xs font-medium h-auto ${
          enabled ? 'bg-green-100 text-green-700 hover:bg-green-100' : 'bg-muted text-muted-foreground'
        }`}
        variant="ghost"
      />
    </form>
  );
}
