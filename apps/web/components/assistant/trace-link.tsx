'use client';

/**
 * OBS-1: "Trace" link for an assistant message footer. Renders nothing when the Phoenix UI base URL
 * is not configured or the message has no trace id. The base URL is provided once for the
 * assistant view by `TraceLinkProvider` (server reads PHOENIX_UI_BASE_URL); a `baseUrl` prop wins.
 *
 * Wiring into the message footer lands with the message renderer (CHAT-2); `traceIdFromMessage`
 * (lib/assistant/trace-link.ts) reads the id from hydrated messages and `traceFromAguiEvent`
 * from a live AG-UI run.
 */
import * as React from 'react';
import { buildTraceUrl } from '@/lib/assistant/trace-link';

const TraceBaseUrlContext = React.createContext<string | null>(null);

export function TraceLinkProvider({ baseUrl, children }: { baseUrl: string | null; children?: React.ReactNode }) {
  return React.createElement(TraceBaseUrlContext.Provider, { value: baseUrl }, children);
}

export function useTraceBaseUrl(): string | null {
  return React.useContext(TraceBaseUrlContext);
}

export interface TraceLinkProps {
  traceId?: string | null;
  /** Overrides the provider's base URL (tests, other views). */
  baseUrl?: string | null;
  className?: string;
}

export function TraceLink({ traceId, baseUrl, className }: TraceLinkProps) {
  const contextBase = useTraceBaseUrl();
  const href = buildTraceUrl(baseUrl === undefined ? contextBase : baseUrl, traceId);
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      data-trace-link=""
      className={className ?? 'text-xs text-muted-foreground underline-offset-2 hover:underline'}
      title="Open this turn's trace"
    >
      Trace
    </a>
  );
}
