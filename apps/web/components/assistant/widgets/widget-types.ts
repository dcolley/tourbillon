/**
 * WID-1: types for chat widgets — compiled React components that render AG-UI tool calls.
 * Only compiled components are registered; nothing is authored or evaluated at runtime.
 */
import type * as React from 'react';
import type { z } from 'zod';
import type { ParsedWidgetCall, WidgetFallbackReason } from '@tourbillon/shared/widgets';

export type WidgetStatus = 'pending' | 'answered';

export interface WidgetComponentProps<P, A> {
  toolCallId: string;
  /** Props validated against the widget's schema. */
  props: P;
  status: WidgetStatus;
  /** The stored answer once the user has answered (cards lock on answer). */
  answer?: A;
  /** Interactive widgets call this once with the user's answer. */
  onAnswer?: (answer: A) => void;
}

export interface WidgetDefinition<P = any, A = any> {
  name: string;
  version: number;
  /** Shown to the model when the widget is declared as a frontend tool. */
  description: string;
  propsSchema: z.ZodType<P>;
  /** Present for interactive widgets: answers are validated before they go back to the run. */
  answerSchema?: z.ZodType<A>;
  component: React.ComponentType<WidgetComponentProps<P, A>>;
  /** Declared to the agent as an AG-UI frontend tool (latest version only). */
  frontendTool?: boolean;
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
export interface FrontendToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type WidgetWarn = (message: string, details: Record<string, unknown>) => void;
