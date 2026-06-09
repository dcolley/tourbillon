export interface TraceContext {
  runId?: string;
  jobId?: string;
  agentId?: string;
  agentName?: string;
  companyId?: string;
  taskId?: string;
  issueId?: string;
  wakeReason?: string;
}

export function safeJson(value: unknown, maxLen = 500): string {
  try {
    const serialized = JSON.stringify(value);
    return serialized.length > maxLen ? `${serialized.slice(0, maxLen)}…` : serialized;
  } catch {
    return String(value);
  }
}

export function formatTrace(
  scope: string,
  ctx: TraceContext,
  message: string,
  data?: Record<string, unknown>
): string {
  const tags = [
    `[trace:${scope}]`,
    ctx.runId ? `run=${ctx.runId.slice(0, 8)}` : null,
    ctx.jobId ? `job=${ctx.jobId}` : null,
    ctx.agentId ? `agent=${ctx.agentId.slice(0, 8)}` : null,
    ctx.agentName ? `name=${ctx.agentName}` : null,
    ctx.taskId ? `task=${ctx.taskId.slice(0, 8)}` : null,
    ctx.issueId ? `issue=${ctx.issueId.slice(0, 8)}` : null,
    ctx.wakeReason ? `wake=${ctx.wakeReason}` : null,
    message,
  ].filter(Boolean);

  const line = tags.join(' ');
  if (!data || Object.keys(data).length === 0) return line;
  return `${line} ${safeJson(data)}`;
}

export function createTraceLogger(scope: string, ctx: TraceContext) {
  return {
    info(message: string, data?: Record<string, unknown>) {
      console.log(formatTrace(scope, ctx, message, data));
    },
    warn(message: string, data?: Record<string, unknown>) {
      console.warn(formatTrace(scope, ctx, message, data));
    },
    error(message: string, data?: Record<string, unknown>) {
      console.error(formatTrace(scope, ctx, message, data));
    },
    child(extra: Partial<TraceContext>) {
      return createTraceLogger(scope, { ...ctx, ...extra });
    },
    format(message: string, data?: Record<string, unknown>) {
      return formatTrace(scope, ctx, message, data);
    },
  };
}

export function summarizeGenerateResult(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== 'object') {
    return { type: typeof result };
  }

  const record = result as Record<string, unknown>;
  const summary: Record<string, unknown> = {
    keys: Object.keys(record),
    usage: record.usage,
  };

  if (typeof record.text === 'string') {
    summary.textLength = record.text.length;
    summary.textPreview = record.text.slice(0, 300);
  }

  if (Array.isArray(record.toolCalls)) {
    summary.toolCalls = record.toolCalls.map((call) => {
      if (!call || typeof call !== 'object') return call;
      const toolCall = call as Record<string, unknown>;
      return {
        toolName: toolCall.toolName ?? toolCall.name ?? toolCall.id,
        args: toolCall.args ?? toolCall.input,
      };
    });
  }

  if (Array.isArray(record.steps)) {
    summary.stepCount = record.steps.length;
    summary.steps = record.steps.map((step, index) => {
      if (!step || typeof step !== 'object') return { index, type: typeof step };
      const stepRecord = step as Record<string, unknown>;
      return {
        index,
        stepType: stepRecord.stepType ?? stepRecord.type,
        toolCalls: Array.isArray(stepRecord.toolCalls) ? stepRecord.toolCalls.length : undefined,
        textLength: typeof stepRecord.text === 'string' ? stepRecord.text.length : undefined,
      };
    });
  }

  return summary;
}
