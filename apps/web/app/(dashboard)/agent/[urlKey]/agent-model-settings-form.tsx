'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import type { AgentModelSettings } from '@tourbillon/shared/model-settings';
import {
  ModelSettingsFields,
  ReasoningLevelField,
  modelSettingsToFormValues,
  type ModelSettingsFormValues,
} from '@/components/model-settings-fields';
import type { ActionResult } from '@/lib/action-result';
import { useActionToast } from '@/hooks/use-action-toast';
import { ActionSubmitButton } from '@/components/action-form';

interface AgentModelSettingsFormProps {
  agentId: string;
  urlKey: string;
  initialSettings?: AgentModelSettings;
  providerDefaults?: AgentModelSettings;
  updateModelSettings: (
    prev: ActionResult | null,
    formData: FormData,
  ) => Promise<ActionResult>;
}

export function AgentModelSettingsForm({
  agentId,
  urlKey,
  initialSettings,
  providerDefaults,
  updateModelSettings,
}: AgentModelSettingsFormProps) {
  const [state, formAction] = useActionState(updateModelSettings, null);
  useActionToast(state);
  const [values, setValues] = useState<ModelSettingsFormValues>(
    modelSettingsToFormValues(initialSettings),
  );

  // Notify open chat panes to refresh agent list after settings save.
  const prevStateRef = useRef<ActionResult | null>(null);
  useEffect(() => {
    if (state && state !== prevStateRef.current && state.ok) {
      prevStateRef.current = state;
      window.dispatchEvent(new CustomEvent('tourbillon:agent-settings-saved'));
    }
  }, [state]);

  return (
    <form action={formAction} className="space-y-4 border-t pt-4">
      <input type="hidden" name="agentId" value={agentId} />
      <input type="hidden" name="urlKey" value={urlKey} />

      <div>
        <h3 className="text-sm font-semibold">Generation settings</h3>
        <p className="text-xs text-muted-foreground mt-1">
          Override provider defaults for this agent. Blank fields inherit from the selected provider,
          then from the endpoint&apos;s own defaults.
        </p>
      </div>

      <ModelSettingsFields
        values={values}
        onChange={setValues}
        providerDefaults={providerDefaults}
        showAdvanced
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <ReasoningLevelField
          value={values.reasoningLevel}
          onChange={(reasoningLevel) => setValues({ ...values, reasoningLevel })}
        />
      </div>

      <ActionSubmitButton label="Save generation settings" />
    </form>
  );
}
