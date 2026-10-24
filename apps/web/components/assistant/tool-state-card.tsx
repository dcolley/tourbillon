/**
 * CHAT-2: compact tool-state card for plain tool calls in the assistant chat (tool calls with no
 * registered widget). Shows the states the AG-UI chat state already tracks (chat-state.ts
 * ToolCallStatus): preparing, running, waiting, done, error, declined, detached. Arguments and
 * results are shown as text only, with values under sensitive-looking keys masked and size capped
 * (same rules as the WID-1 fallback card).
 */
import * as React from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { argsPreview, PREVIEW_TRUNCATED } from '@/components/assistant/widgets/fallback-card';
import type { ToolCallStatus } from '@/lib/agui/client/chat-state';
import { WIDGET_MAX_PREVIEW_CHARS, redactWidgetValue } from '@tourbillon/shared/widgets';

export type ToolCardVariant = 'running' | 'waiting' | 'done' | 'error' | 'declined' | 'detached';

export const TOOL_STATE: Record<ToolCallStatus, { variant: ToolCardVariant; label: string }> = {
  streaming_args: { variant: 'running', label: 'Preparing' },
  running: { variant: 'running', label: 'Running' },
  awaiting_approval: { variant: 'waiting', label: 'Waiting for approval' },
  suspended: { variant: 'waiting', label: 'Waiting for input' },
  done: { variant: 'done', label: 'Done' },
  error: { variant: 'error', label: 'Error' },
  denied: { variant: 'declined', label: 'Declined' },
  detached: { variant: 'detached', label: 'Result not shown' },
};

/** Results longer than this are not parsed or shown. */
export const TOOL_RESULT_MAX_CHARS = 64 * 1024;
export const RESULT_TOO_LARGE = '(result too large to show)';

/** Tool result as display text: JSON pretty-printed with sensitive keys masked, other text as is; capped. */
export function resultPreview(result: string | undefined): string | null {
  if (result === undefined || result === '') return null;
  if (result.length > TOOL_RESULT_MAX_CHARS) return RESULT_TOO_LARGE;
  let text = result;
  try {
    const parsed: unknown = JSON.parse(result);
    text = typeof parsed === 'string' ? parsed : JSON.stringify(redactWidgetValue(parsed), null, 2);
  } catch {
    // Not JSON: plain text result.
  }
  return text.length > WIDGET_MAX_PREVIEW_CHARS ? text.slice(0, WIDGET_MAX_PREVIEW_CHARS) + PREVIEW_TRUNCATED : text;
}

const BADGE_CLASS: Record<ToolCardVariant, string> = {
  running: 'text-muted-foreground',
  waiting: 'border-amber-500/50 text-amber-700 dark:text-amber-400',
  done: 'border-emerald-500/50 text-emerald-700 dark:text-emerald-400',
  error: 'border-destructive/50 text-destructive',
  declined: 'text-muted-foreground',
  detached: 'text-muted-foreground',
};

export interface ToolStateCardProps {
  toolCallId: string;
  toolName: string;
  status: ToolCallStatus;
  argsText?: string;
  result?: string;
}

export function ToolStateCard({ toolCallId, toolName, status, argsText, result }: ToolStateCardProps) {
  const { variant, label } = TOOL_STATE[status] ?? TOOL_STATE.running;
  // Arguments still streaming are partial JSON: show them once complete.
  const args = status === 'streaming_args' ? null : argsPreview(argsText || undefined);
  const output = resultPreview(result);
  const isError = variant === 'error';
  return (
    <Card size="sm" data-tool-card data-tool-state={variant} data-tool-call-id={toolCallId}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <span className="font-mono">{toolName || 'Tool call'}</span>
          <span data-status={status} className={`rounded-full border px-2 text-xs font-normal ${BADGE_CLASS[variant]}`}>
            {label}
            {variant === 'running' ? '…' : ''}
          </span>
        </CardTitle>
        {variant === 'detached' ? <CardDescription>Approved after the run ended, so the result is not shown in this chat.</CardDescription> : null}
        {variant === 'declined' ? <CardDescription>This tool call was declined and did not run.</CardDescription> : null}
      </CardHeader>
      {args || output ? (
        <CardContent className="space-y-1">
          {args ? (
            <details data-tool-section="arguments">
              <summary className="cursor-pointer text-xs text-muted-foreground">Arguments</summary>
              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2 text-xs">{args}</pre>
            </details>
          ) : null}
          {output ? (
            <details data-tool-section={isError ? 'error' : 'result'} open={isError || undefined}>
              <summary className={`cursor-pointer text-xs ${isError ? 'text-destructive' : 'text-muted-foreground'}`}>
                {isError ? 'Error' : 'Result'}
              </summary>
              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2 text-xs">{output}</pre>
            </details>
          ) : null}
        </CardContent>
      ) : null}
    </Card>
  );
}
