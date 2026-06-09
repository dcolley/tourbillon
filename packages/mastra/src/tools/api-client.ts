import { RequestContext } from '@mastra/core/request-context';
import { formatTrace, safeJson, type TraceContext } from '@tourbillon/shared';

export function getInternalApiUrl(): string {
  return process.env.INTERNAL_API_URL ?? 'http://localhost:3000';
}

export interface HeartbeatRuntimeValues {
  apiKey: string;
  runId: string;
  agentId: string;
  companyId: string;
  taskId?: string;
}

export interface ToolRuntimeContext extends TraceContext {
  apiKey?: string;
}

export function createHeartbeatRuntimeContext(
  values: HeartbeatRuntimeValues
): RequestContext<HeartbeatRuntimeValues> {
  const requestContext = new RequestContext<HeartbeatRuntimeValues>();
  requestContext.set('apiKey', values.apiKey);
  requestContext.set('runId', values.runId);
  requestContext.set('agentId', values.agentId);
  requestContext.set('companyId', values.companyId);
  if (values.taskId) requestContext.set('taskId', values.taskId);
  return requestContext;
}

export function extractToolRuntimeContext(requestContext: unknown): ToolRuntimeContext {
  if (
    requestContext &&
    typeof requestContext === 'object' &&
    'get' in requestContext &&
    typeof (requestContext as { get: unknown }).get === 'function'
  ) {
    const ctx = requestContext as { get: (key: string) => unknown };
    return {
      runId: asString(ctx.get('runId')),
      agentId: asString(ctx.get('agentId')),
      companyId: asString(ctx.get('companyId')),
      taskId: asString(ctx.get('taskId')),
      apiKey: asString(ctx.get('apiKey')),
    };
  }

  const value = (requestContext ?? {}) as Record<string, unknown>;
  return {
    runId: asString(value.runId),
    agentId: asString(value.agentId),
    companyId: asString(value.companyId),
    taskId: asString(value.taskId),
    apiKey: asString(value.apiKey),
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function toolHeaders(apiKey: string, runId?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  if (runId) headers['X-Paperclip-Run-Id'] = runId;
  return headers;
}

export async function tracedAgentFetch(
  toolId: string,
  requestContext: unknown,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const ctx = extractToolRuntimeContext(requestContext);
  const apiBase = getInternalApiUrl();
  const method = init.method ?? 'GET';
  const url = `${apiBase}${path}`;
  const start = Date.now();

  console.log(
    formatTrace('tool', ctx, `→ ${toolId} ${method} ${path}`, {
      apiBase,
      hasApiKey: Boolean(ctx.apiKey),
      hasRunId: Boolean(ctx.runId),
      hasAgentId: Boolean(ctx.agentId),
      body: init.body ? safeJson(init.body, 200) : undefined,
    })
  );

  if (!ctx.apiKey) {
    console.warn(
      formatTrace('tool', ctx, `missing apiKey for ${toolId} — requestContext not passed to tool execute`)
    );
  }

  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        ...toolHeaders(ctx.apiKey ?? '', ctx.runId),
        ...(init.headers as Record<string, string> | undefined),
      },
    });
  } catch (err) {
    console.error(
      formatTrace('tool', ctx, `✗ ${toolId} network error`, {
        path,
        apiBase,
        ms: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      })
    );
    throw err;
  }

  const logData: Record<string, unknown> = { ms: Date.now() - start, apiBase };
  if (!response.ok) {
    logData.body = (await response.clone().text()).slice(0, 400);
    console.warn(formatTrace('tool', ctx, `← ${toolId} HTTP ${response.status} ${method} ${path}`, logData));
  } else {
    console.log(formatTrace('tool', ctx, `← ${toolId} HTTP ${response.status} ${method} ${path}`, logData));
  }

  return response;
}
