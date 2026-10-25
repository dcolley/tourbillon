'use client';

/**
 * CHAT-5: model and effort picker for one assistant thread, shown in the composer.
 *
 * Provider: "Agent default (…)" or one of the providers switched on for the company (only those
 * the server returns). Model: the provider's models. Effort: only when the model supports it.
 * The choice is saved on the thread and applies to that thread only. Changes are disabled while a
 * run is open (the server refuses them too).
 */
import * as React from 'react';
import { REASONING_LEVEL_LABELS } from '@tourbillon/shared/reasoning-capabilities';
import type { ReasoningLevel } from '@tourbillon/shared/model-settings';
import {
  createModelPickerController,
  type ModelPickerController,
  type ModelPickerSnapshot,
} from './model-picker-controller';

const selectClass =
  'h-7 max-w-[14rem] truncate rounded-md border bg-transparent px-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-60';

export interface ModelPickerViewProps {
  snapshot: ModelPickerSnapshot;
  /** True while a run is open on the thread. */
  disabled?: boolean;
  onProvider: (providerId: string) => void;
  onModel: (modelId: string) => void;
  onEffort: (level: ReasoningLevel | '') => void;
}

function agentDefaultLabel(snapshot: ModelPickerSnapshot): string {
  const d = snapshot.state?.agentDefault;
  const parts = [d?.providerName, d?.modelId].filter(Boolean);
  return parts.length > 0 ? `Agent default (${parts.join(' · ')})` : 'Agent default';
}

/** Stateless view (tested with react-dom/server). */
export function ModelPickerView({ snapshot, disabled, onProvider, onModel, onEffort }: ModelPickerViewProps) {
  if (snapshot.status === 'loading' && !snapshot.state) {
    return (
      <span className="text-xs text-muted-foreground" data-model-picker="loading">
        Loading models…
      </span>
    );
  }
  if (snapshot.status === 'error' && !snapshot.state) {
    return (
      <span className="text-xs text-destructive" data-model-picker="error" role="alert">
        {snapshot.error ?? 'Could not load the model'}
      </span>
    );
  }
  const state = snapshot.state!;
  const locked = Boolean(disabled) || snapshot.saving;
  const modelIds = (snapshot.models ?? []).map((m) => m.id);
  // Keep the current model listed even when the provider's list no longer has it.
  if (snapshot.modelId && !modelIds.includes(snapshot.modelId)) modelIds.unshift(snapshot.modelId);
  const showEffort = Boolean(snapshot.providerId && snapshot.modelId && snapshot.effortLevels.length > 0);

  return (
    <div
      className="flex flex-wrap items-center gap-1.5"
      data-model-picker="ready"
      data-thread-model={snapshot.providerId ? 'thread' : 'agent'}
      title={disabled ? 'The model can be changed when the reply has finished' : undefined}
    >
      <select
        aria-label="Provider"
        className={selectClass}
        disabled={locked}
        value={snapshot.providerId}
        onChange={(e) => onProvider(e.target.value)}
      >
        <option value="">{agentDefaultLabel(snapshot)}</option>
        {state.providers.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      {snapshot.providerId && (
        <select
          aria-label="Model"
          className={selectClass}
          disabled={locked || snapshot.modelsLoading}
          value={snapshot.modelId}
          onChange={(e) => onModel(e.target.value)}
        >
          <option value="" disabled>
            {snapshot.modelsLoading ? 'Loading models…' : modelIds.length > 0 ? 'Choose a model' : 'No models'}
          </option>
          {modelIds.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
      )}
      {showEffort && (
        <select
          aria-label="Effort"
          className={selectClass}
          disabled={locked}
          value={snapshot.reasoningLevel}
          onChange={(e) => onEffort(e.target.value as ReasoningLevel | '')}
        >
          <option value="">Default effort</option>
          {snapshot.effortLevels.map((level) => (
            <option key={level} value={level}>
              {REASONING_LEVEL_LABELS[level]}
            </option>
          ))}
        </select>
      )}
      {snapshot.saving && <span className="text-xs text-muted-foreground">Saving…</span>}
      {snapshot.error && (
        <span className="text-xs text-destructive" role="alert" data-model-picker-error>
          {snapshot.error}
        </span>
      )}
    </div>
  );
}

/** Picker bound to one thread. */
export function ModelPicker({
  agentId,
  threadId,
  disabled,
  controller: provided,
  onStateChange,
}: {
  agentId: string;
  threadId: string;
  disabled?: boolean;
  controller?: ModelPickerController;
  /** CTX-1: called when the thread's model state loads or changes (e.g. refresh the context meter). */
  onStateChange?: () => void;
}) {
  const controller = React.useMemo(
    () => provided ?? createModelPickerController({ agentId, threadId }),
    [provided, agentId, threadId],
  );
  const snapshot = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  React.useEffect(() => {
    void controller.load();
  }, [controller]);
  const onStateChangeRef = React.useRef(onStateChange);
  React.useEffect(() => {
    onStateChangeRef.current = onStateChange;
  }, [onStateChange]);
  const modelState = snapshot.state;
  React.useEffect(() => {
    if (modelState) onStateChangeRef.current?.();
  }, [modelState]);
  return (
    <ModelPickerView
      snapshot={snapshot}
      disabled={disabled}
      onProvider={(id) => void controller.selectProvider(id)}
      onModel={(id) => void controller.selectModel(id)}
      onEffort={(level) => void controller.selectEffort(level)}
    />
  );
}
