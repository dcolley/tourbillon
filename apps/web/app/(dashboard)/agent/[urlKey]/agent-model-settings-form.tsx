'use client';

import { useState } from 'react';
import type { AgentModelSettings } from '@tourbillon/shared/model-settings';
import type { ModelReasoningCapabilities } from '@tourbillon/shared/reasoning-capabilities';
import {
  ModelSettingsFields,
  ReasoningLevelField,
  modelSettingsToFormValues,
  type ModelSettingsFormValues,
} from '@/components/model-settings-fields';

interface AgentModelSettingsFormProps {
  agentId: string;
  urlKey: string;
  reasoningCapabilities: ModelReasoningCapabilities;
  initialSettings?: AgentModelSettings;
  providerDefaults?: AgentModelSettings;
  updateModelSettings: (formData: FormData) => Promise<void>;
}

export function AgentModelSettingsForm({
  agentId,
  urlKey,
  reasoningCapabilities,
  initialSettings,
  providerDefaults,
  updateModelSettings,
}: AgentModelSettingsFormProps) {
  const [values, setValues] = useState<ModelSettingsFormValues>(
    modelSettingsToFormValues(initialSettings),
  );

  const staleReasoningLevel =
    !reasoningCapabilities.supported && initialSettings?.reasoningLevel
      ? initialSettings.reasoningLevel
      : undefined;

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

      {reasoningCapabilities.supported ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <ReasoningLevelField
            value={values.reasoningLevel}
            allowedLevels={reasoningCapabilities.allowedLevels}
            onChange={(reasoningLevel) => setValues({ ...values, reasoningLevel })}
          />
        </div>
      ) : staleReasoningLevel ? (
        <p className="text-xs text-muted-foreground">
          Saved reasoning level ({staleReasoningLevel}) is ignored because the current model does not
          support reasoning.
        </p>
      ) : null}

      <button
        type="submit"
        className="inline-flex items-center justify-center rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
      >
        Save generation settings
      </button>
    </form>
  );
}
