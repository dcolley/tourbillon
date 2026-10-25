/**
 * WID-1: types for chat widgets — compiled React components that render AG-UI tool calls.
 * Only compiled components are registered; nothing is authored or evaluated at runtime.
 */
import type * as React from 'react';
import type { ParsedWidgetCall, WidgetFallbackReason, WidgetFrontendTool, WidgetSpec } from '@tourbillon/shared/widgets';

/** `dismissed` (WID-3): the user closed the card without answering; it renders locked. */
export type WidgetStatus = 'pending' | 'answered' | 'dismissed';

export interface WidgetComponentProps<P, A> {
  toolCallId: string;
  /** Props validated against the widget's schema. */
  props: P;
  status: WidgetStatus;
  /** The stored answer once the user has answered (cards lock on answer). */
  answer?: A;
  /** Interactive widgets call this once with the user's answer (absent while the card cannot be answered). */
  onAnswer?: (answer: A) => void;
  /** WID-3: dismiss the card without answering (absent while it cannot be dismissed). */
  onDismiss?: () => void;
  /** WID-3: an answer or dismissal is on its way; the card shows it and stays locked. */
  busy?: boolean;
}

/**
 * A widget spec (name, version, description, strict props / answer schemas; see
 * @tourbillon/shared/widgets) paired with its compiled component.
 */
export interface WidgetDefinition<P = any, A = any> extends WidgetSpec<P, A> {
  component: React.ComponentType<WidgetComponentProps<P, A>>;
}

export type WidgetResolution =
  | { ok: true; definition: WidgetDefinition; call: ParsedWidgetCall & { props: unknown } }
  | {
      ok: false;
      reason: WidgetFallbackReason;
      toolCallId?: string;
      toolName?: string;
      /** Paths of invalid props (no values), for logs. */
      issues?: string[];
    };

/** AG-UI `Tool` shape (name, description, JSON Schema parameters). */
export type FrontendToolDefinition = WidgetFrontendTool;

export type WidgetWarn = (message: string, details: Record<string, unknown>) => void;
