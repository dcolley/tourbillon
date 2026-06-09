import { formatTrace, safeJson, type TraceContext } from '@tourbillon/shared';
import type { RunTokenPayload } from '@/lib/auth/run-token';

export function traceFromRunToken(runCtx: RunTokenPayload | null): TraceContext {
  if (!runCtx) return {};
  return {
    runId: runCtx.runId,
    agentId: runCtx.agentId,
    companyId: runCtx.companyId,
  };
}

export function logAgentApiRequest(
  route: string,
  method: string,
  runCtx: RunTokenPayload | null,
  extra?: Record<string, unknown>
): void {
  if (!runCtx) {
    console.warn(formatTrace('api', {}, `${method} ${route} unauthorized`, extra));
    return;
  }

  console.log(formatTrace('api', traceFromRunToken(runCtx), `${method} ${route}`, extra));
}

export function logAgentApiResponse(
  route: string,
  method: string,
  runCtx: RunTokenPayload | null,
  status: number,
  extra?: Record<string, unknown>
): void {
  const ctx = traceFromRunToken(runCtx);
  const payload = { status, ...extra };
  if (status >= 400) {
    console.warn(formatTrace('api', ctx, `${method} ${route} response`, payload));
  } else {
    console.log(formatTrace('api', ctx, `${method} ${route} response`, payload));
  }
}

export function summarizeBody(body: unknown, maxLen = 300): string | undefined {
  if (body === undefined) return undefined;
  return safeJson(body, maxLen);
}
