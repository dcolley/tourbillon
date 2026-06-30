'use client';

import { useState } from 'react';
import type { AgentModelSettings } from '@tourbillon/shared';
import {
  ModelSettingsFields,
  modelSettingsToFormValues,
  type ModelSettingsFormValues,
} from '@/components/model-settings-fields';

interface AgentModelSettingsFormProps {
  agentId: string;
  urlKey: string;
  initialSettings?: AgentModelSettings;
  providerDefaults?: AgentModelSettings;
  updateModelSettings: (formData: FormData) => Promise<void>;
}

export function AgentModelSettingsForm({
  agentId,
  urlKey,
  initialSettings,
  providerDefaults,
  updateModelSettings,
}: AgentModelSettingsFormProps) {
  const [values, setValues] = useState<ModelSettingsFormValues>(
    modelSettingsToFormValues(initialSettings),
  );

  return (
    <form action={updateModelSettings} className="space-y-4 border-t pt-4">
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

      <button
        type="submit"
        className="inline-flex items-center justify-center rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
      >
        Save generation settings
      </button>
    </form>
  );
}
