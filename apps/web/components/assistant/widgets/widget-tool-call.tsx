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
  /** WID-3: the user dismissed the card (it renders locked as dismissed). */
  dismissed?: boolean;
  /** WID-3: whether the card takes an answer now (e.g. only while its run waits on it). Default true. */
  answerable?: boolean;
  /** WID-3: an answer or dismissal is being sent; the card stays locked meanwhile. */
  busy?: boolean;
  /**
   * WID-3: failed sends so far. When it grows, the card takes one more answer (a refused or failed
   * answer can be corrected and sent again); otherwise only the first answer is handed back.
   */
  attempt?: number;
  /** WID-3: receives a dismissal (no answer). */
  onDismiss?: () => void;
}

/** WID-1: render a tool call as its registered widget, or the fallback card — never blank. */
export function WidgetToolCall({
  registry,
  toolCall,
  toolStatus,
  answer,
  onAnswer,
  onInvalidAnswer,
  dismissed = false,
  answerable = true,
  busy = false,
  attempt = 0,
  onDismiss,
}: WidgetToolCallProps) {
  const resolution = React.useMemo(() => registry.resolve(toolCall), [registry, toolCall]);
  /**
   * One accepted answer (or dismissal) per attempt, even if the widget fires again before the stored
   * answer arrives: holds the attempt the last one was handed back on.
   */
  const answeredRef = React.useRef<number | null>(null);
  const used = () => answeredRef.current !== null && answeredRef.current >= attempt;

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
  const status: WidgetStatus = answer !== undefined ? 'answered' : dismissed ? 'dismissed' : 'pending';
  const open = status === 'pending' && answerable && !busy;
  const handleAnswer =
    open && definition.answerSchema
      ? (value: unknown) => {
          if (used()) return;
          const accepted = registry.acceptAnswer(resolution, value);
          if (accepted.ok) {
            answeredRef.current = attempt;
            onAnswer?.({ toolResult: accepted.toolResult, record: accepted.record });
          } else onInvalidAnswer?.(accepted.issues);
        }
      : undefined;
  const handleDismiss =
    open && onDismiss
      ? () => {
          if (used()) return;
          answeredRef.current = attempt;
          onDismiss();
        }
      : undefined;

  return (
    <div
      data-widget={definition.name}
      data-widget-version={definition.version}
      data-tool-call-id={call.toolCallId}
      data-widget-status={status}
    >
      <Component
        toolCallId={call.toolCallId}
        props={call.props}
        status={status}
        answer={answer}
        onAnswer={handleAnswer}
        onDismiss={handleDismiss}
        busy={busy}
      />
    </div>
  );
}
