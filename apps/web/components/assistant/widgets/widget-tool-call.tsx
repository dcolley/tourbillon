'use client';

import * as React from 'react';
import { FallbackToolCard, type ToolCardStatus } from './fallback-card';
import type { WidgetRegistry } from './registry';
import type { WidgetStatus } from './widget-types';

export interface WidgetToolCallProps {
  registry: WidgetRegistry;
  /** Assembled AG-UI tool call: `{ toolCallId, toolName, args }`. */
  toolCall: { toolCallId: string; toolName: string; args: unknown };
  /** Tool state, used by the fallback card. */
  toolStatus?: ToolCardStatus;
  /** Stored answer, if the user already answered (the widget renders locked). */
  answer?: unknown;
  /** Receives the validated tool result for the run and the answer record to store. */
  onAnswer?: (result: { toolResult: string; record: unknown }) => void;
  /** Answers that fail the widget's answer schema (the widget stays open). */
  onInvalidAnswer?: (issues: string[]) => void;
}

/** WID-1: render a tool call as its registered widget, or the fallback card — never blank. */
export function WidgetToolCall({ registry, toolCall, toolStatus, answer, onAnswer, onInvalidAnswer }: WidgetToolCallProps) {
  const resolution = React.useMemo(() => registry.resolve(toolCall), [registry, toolCall]);
  /** One accepted answer per mounted card, even if the widget fires again before the stored answer arrives. */
  const answeredRef = React.useRef(false);

  if (!resolution.ok) {
    return (
      <FallbackToolCard
        toolName={toolCall.toolName}
        toolCallId={toolCall.toolCallId}
        status={toolStatus}
        reason={resolution.reason}
        args={toolCall.args}
      />
    );
  }

  const { definition, call } = resolution;
  const Component = definition.component;
  const status: WidgetStatus = answer === undefined ? 'pending' : 'answered';
  const handleAnswer =
    status === 'pending' && definition.answerSchema
      ? (value: unknown) => {
          if (answeredRef.current) return;
          const accepted = registry.acceptAnswer(resolution, value);
          if (accepted.ok) {
            answeredRef.current = true;
            onAnswer?.({ toolResult: accepted.toolResult, record: accepted.record });
          } else onInvalidAnswer?.(accepted.issues);
        }
      : undefined;

  return (
    <div data-widget={definition.name} data-widget-version={definition.version} data-tool-call-id={call.toolCallId}>
      <Component toolCallId={call.toolCallId} props={call.props} status={status} answer={answer} onAnswer={handleAnswer} />
    </div>
  );
}
