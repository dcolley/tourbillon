import * as React from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { WIDGET_FALLBACK_MESSAGES, redactWidgetValue, type WidgetFallbackReason } from '@tourbillon/shared/widgets';

export type ToolCardStatus = 'running' | 'done' | 'failed';

export interface FallbackToolCardProps {
  toolName?: string;
  toolCallId?: string;
  status?: ToolCardStatus;
  /** Why the widget could not be shown; omitted for plain tool calls with no widget. */
  reason?: WidgetFallbackReason;
  /** Tool args as streamed (object or JSON string); sensitive keys are masked for display. */
  args?: unknown;
}

const STATUS_LABEL: Record<ToolCardStatus, string> = { running: 'Running', done: 'Done', failed: 'Failed' };

function argsPreview(args: unknown): string | null {
  if (args === undefined || args === null || args === '') return null;
  let value = args;
  if (typeof args === 'string') {
    try {
      value = JSON.parse(args);
    } catch {
      return '(arguments could not be read)';
    }
  }
  try {
    return JSON.stringify(redactWidgetValue(value), null, 2);
  } catch {
    return '(arguments could not be shown)';
  }
}

/**
 * WID-1: generic tool-state card. Shown for any tool call without a usable widget, so a tool call
 * is never rendered blank.
 */
export function FallbackToolCard({ toolName, toolCallId, status = 'running', reason, args }: FallbackToolCardProps) {
  const preview = argsPreview(args);
  return (
    <Card size="sm" data-widget="fallback" data-reason={reason ?? 'none'} data-tool-call-id={toolCallId}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <span className="font-mono">{toolName || 'Tool call'}</span>
          <span data-status={status} className="rounded-full border px-2 text-xs font-normal text-muted-foreground">
            {STATUS_LABEL[status]}
          </span>
        </CardTitle>
        {reason ? <CardDescription>{WIDGET_FALLBACK_MESSAGES[reason]}</CardDescription> : null}
      </CardHeader>
      {preview ? (
        <CardContent>
          <details>
            <summary className="cursor-pointer text-xs text-muted-foreground">Arguments</summary>
            <pre className="mt-2 max-h-64 overflow-auto rounded bg-muted p-2 text-xs">{preview}</pre>
          </details>
        </CardContent>
      ) : null}
    </Card>
  );
}
