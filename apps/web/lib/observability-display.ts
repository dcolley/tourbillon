/**
 * Human-readable formatting for observability previews and payloads.
 */

interface MessageContentPart {
  type?: string;
  text?: string;
  name?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  id?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function looksLikeJson(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

function tryParseJson(text: string): unknown | null {
  const trimmed = text.trim();
  if (!looksLikeJson(trimmed)) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

/** Attempt to parse JSON truncated mid-stream by closing open brackets/braces. */
function balanceAndParseJson(text: string): unknown | null {
  const trimmed = text.trim();
  if (!looksLikeJson(trimmed)) return null;

  const direct = tryParseJson(trimmed);
  if (direct !== null) return direct;

  let braces = 0;
  let brackets = 0;
  let inString = false;
  let escaped = false;

  for (const ch of trimmed) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') braces++;
    if (ch === '}') braces--;
    if (ch === '[') brackets++;
    if (ch === ']') brackets--;
  }

  let candidate = trimmed;
  if (inString) {
    // Truncated inside a string — trim back to last completed value boundary.
    const cutPoints = [
      candidate.lastIndexOf('","'),
      candidate.lastIndexOf('},'),
      candidate.lastIndexOf('],'),
      candidate.lastIndexOf('":'),
    ].filter((i) => i >= 0);
    if (cutPoints.length > 0) {
      const cut = Math.max(...cutPoints);
      candidate = candidate.slice(0, cut + (candidate[cut] === ':' ? 1 : 2));
      braces = 0;
      brackets = 0;
      inString = false;
      escaped = false;
      for (const ch of candidate) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === '\\' && inString) {
          escaped = true;
          continue;
        }
        if (ch === '"') {
          inString = !inString;
          continue;
        }
        if (inString) continue;
        if (ch === '{') braces++;
        if (ch === '}') braces--;
        if (ch === '[') brackets++;
        if (ch === ']') brackets--;
      }
    }
  }

  candidate += ']'.repeat(Math.max(0, brackets)) + '}'.repeat(Math.max(0, braces));
  return tryParseJson(candidate);
}

/** Best-effort pretty printer for invalid or partial JSON text. */
function prettyPrintJsonFragment(text: string): string {
  const parsed = tryParseJson(text) ?? balanceAndParseJson(text);
  if (parsed !== null) return JSON.stringify(parsed, null, 2);

  let result = '';
  let indent = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      result += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && inString) {
      result += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      result += ch;
      continue;
    }
    if (!inString) {
      if (ch === '{' || ch === '[') {
        result += ch + '\n' + '  '.repeat(indent + 1);
        indent++;
        continue;
      }
      if (ch === '}' || ch === ']') {
        indent = Math.max(0, indent - 1);
        result += '\n' + '  '.repeat(indent) + ch;
        continue;
      }
      if (ch === ',') {
        result += ',\n' + '  '.repeat(indent);
        continue;
      }
      if (ch === ':') {
        result += ': ';
        continue;
      }
    }
    result += ch;
  }

  return result;
}

/**
 * Recursively parse JSON-looking strings so nested payloads (e.g. preview) become
 * objects before pretty-printing.
 */
function normalizeJsonDeep(value: unknown, depth = 0): unknown {
  if (depth > 8) return value;

  if (typeof value === 'string') {
    const parsed = tryParseJson(value) ?? balanceAndParseJson(value);
    if (parsed !== null) return normalizeJsonDeep(parsed, depth + 1);
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeJsonDeep(item, depth + 1));
  }

  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      if (key === 'preview' && typeof val === 'string' && looksLikeJson(val)) {
        const parsed = tryParseJson(val) ?? balanceAndParseJson(val);
        if (parsed !== null) {
          out[key] = normalizeJsonDeep(parsed, depth + 1);
          continue;
        }
        // Unparseable partial JSON — keep raw key plus formatted sibling for display.
        out[key] = val;
        out[`${key}_formatted`] = prettyPrintJsonFragment(val);
        continue;
      }
      out[key] = normalizeJsonDeep(val, depth + 1);
    }
    return out;
  }

  return value;
}

function stringifyPreviewField(value: unknown, indent: number): string | null {
  if (typeof value !== 'string' || !looksLikeJson(value)) return null;
  const parsed = tryParseJson(value) ?? balanceAndParseJson(value);
  if (parsed !== null) return JSON.stringify(parsed, null, 2);
  return prettyPrintJsonFragment(value);
}

/** Detect HTML error pages (e.g. Next.js 404) and return a short summary. */
export function summarizeTextResult(text: string): string {
  if (!text.trim()) return '(empty)';

  if (
    text.includes('<!DOCTYPE html') ||
    text.includes('<html') ||
    text.includes('next-error-h1')
  ) {
    const httpMatch = text.match(/HTTP (\d{3})/i);
    const titleMatch = text.match(/<title>([^<]+)<\/title>/i);
    const parts: string[] = ['HTML error response'];
    if (httpMatch) parts.push(`HTTP ${httpMatch[1]}`);
    if (titleMatch) parts.push(titleMatch[1].trim());
    return parts.join(' · ');
  }

  if (text.length > 500) return `${text.slice(0, 500)}…`;
  return text;
}

/** Summarize a tool result object or string for list/detail previews. */
export function summarizeToolResult(result: unknown): string {
  if (result == null) return '(empty)';

  if (typeof result === 'string') {
    return summarizeTextResult(result);
  }

  if (Array.isArray(result)) {
    return `Array(${result.length})`;
  }

  if (!isRecord(result)) return String(result);

  if (typeof result.error === 'string' || typeof result.error === 'number') {
    const message =
      typeof result.message === 'string'
        ? summarizeTextResult(result.message)
        : '';
    return message ? `Error ${result.error}: ${message}` : `Error ${result.error}`;
  }

  if (Array.isArray(result.entries)) {
    return `${result.entries.length} workspace file${result.entries.length === 1 ? '' : 's'}`;
  }
  if (Array.isArray(result.comments)) {
    return `${result.comments.length} comment${result.comments.length === 1 ? '' : 's'}`;
  }
  if (Array.isArray(result.issues)) {
    const ids = result.issues
      .filter((i): i is Record<string, unknown> => isRecord(i))
      .map((i) => (typeof i.identifier === 'string' ? i.identifier : i.id))
      .filter(Boolean)
      .slice(0, 3);
    const suffix = result.issues.length > 3 ? ` +${result.issues.length - 3} more` : '';
    return ids.length > 0 ? `Inbox: ${ids.join(', ')}${suffix}` : `${result.issues.length} issues`;
  }
  if (typeof result.content === 'string') {
    const lines = result.content.split('\n').length;
    return `File (${lines} lines, ${result.content.length} chars)`;
  }
  if (typeof result.id === 'string' && typeof result.name === 'string') {
    return `${result.name} (${result.role ?? 'agent'})`;
  }

  const json = JSON.stringify(result);
  return json.length > 400 ? `${json.slice(0, 400)}…` : json;
}

/** Summarize harness message.content parts into a one-line preview. */
export function summarizeMessageContent(content: unknown): string | null {
  if (!Array.isArray(content) || content.length === 0) return null;

  const parts = content as MessageContentPart[];
  const toolCalls = parts.filter((p) => p.type === 'tool_call' && p.name);
  const toolResults = parts.filter((p) => p.type === 'tool_result' && p.name);
  const textParts = parts
    .filter((p) => p.type === 'text' && typeof p.text === 'string' && p.text.trim())
    .map((p) => p.text!.trim());

  const segments: string[] = [];

  if (toolCalls.length > 0) {
    const names = [...new Set(toolCalls.map((p) => p.name!))];
    segments.push(
      `${toolCalls.length} tool call${toolCalls.length === 1 ? '' : 's'}: ${names.slice(0, 5).join(', ')}${names.length > 5 ? '…' : ''}`,
    );
  }

  if (toolResults.length > 0) {
    const errors = toolResults.filter((p) => p.isError).length;
    segments.push(
      `${toolResults.length} result${toolResults.length === 1 ? '' : 's'}${errors > 0 ? ` (${errors} error${errors === 1 ? '' : 's'})` : ''}`,
    );
  }

  if (textParts.length > 0) {
    const combined = textParts.join(' ');
    segments.push(combined.length > 120 ? `${combined.slice(0, 120)}…` : combined);
  }

  return segments.length > 0 ? segments.join(' · ') : null;
}

/** Build the best single-line preview for a table row. */
export function formatEventPreview(event: {
  eventType: string;
  name: string;
  toolId: string | null;
  inputPreview: string | null;
  outputPreview: string | null;
  payload: Record<string, unknown>;
  errorText: string | null;
}): string {
  if (event.errorText) return event.errorText;

  if (event.eventType === 'tool_call_start' || event.eventType === 'tool_call') {
    const args = event.inputPreview ? tryParseJson(event.inputPreview) : null;
    if (args && isRecord(args) && Object.keys(args).length > 0) {
      const argSummary = JSON.stringify(args);
      return argSummary.length > 100 ? `${argSummary.slice(0, 100)}…` : argSummary;
    }
    return event.toolId ?? event.name;
  }

  if (event.eventType === 'tool_call_result' || event.eventType === 'tool_call') {
    if (event.outputPreview) {
      const parsed = tryParseJson(event.outputPreview);
      if (parsed !== null) return summarizeToolResult(parsed);
      return summarizeTextResult(event.outputPreview);
    }
  }

  if (event.eventType === 'usage_update') {
    return 'Token usage update';
  }

  if (event.eventType === 'text_delta') {
    const fromPayload = extractMessageSummaryFromPayload(event.payload);
    if (fromPayload) return fromPayload;
  }

  if (isModelStepEvent(event.eventType, event.name)) {
    const step = extractModelStepOutput(event.payload);
    if (step) return summarizeModelStepPreview(step);
  }

  if (isModelInferenceEvent(event.eventType, event.name)) {
    const summary = extractModelInferenceSummary(event.payload, event.name);
    if (summary) {
      const parts = ['Provider call'];
      if (summary.finishReason) parts.push(summary.finishReason);
      if (summary.outputTokens != null) parts.push(`${summary.outputTokens} tok`);
      return parts.join(' · ');
    }
  }

  if (isModelChunkEvent(event.eventType, event.name)) {
    const chunk = extractModelChunkOutput(event.payload, event.name);
    if (chunk?.text?.trim()) {
      const prefix = chunk.chunkType === 'reasoning' ? 'Reasoning' : 'Text';
      const snippet = chunk.text.trim();
      return `${prefix}: ${snippet.length > 100 ? `${snippet.slice(0, 100)}…` : snippet}`;
    }
    if (chunk) return `Chunk: ${chunk.chunkType}`;
  }

  const output = event.outputPreview ?? event.inputPreview;
  if (!output) return '—';

  const parsed = tryParseJson(output);
  if (parsed !== null) {
    if (isRecord(parsed) && parsed.type === 'message_update' && isRecord(parsed.message)) {
      const summary = summarizeMessageContent(parsed.message.content);
      if (summary) return summary;
    }
    if (isRecord(parsed) && parsed.truncated && typeof parsed.preview === 'string') {
      const inner = tryParseJson(parsed.preview);
      if (inner !== null && isRecord(inner) && inner.type === 'message_update') {
        const summary = summarizeMessageContent(
          isRecord(inner.message) ? inner.message.content : null,
        );
        if (summary) return summary;
      }
      return 'Truncated payload (expand for details)';
    }
    return summarizeToolResult(parsed);
  }

  return summarizeTextResult(output);
}

function extractMessageSummaryFromPayload(payload: Record<string, unknown>): string | null {
  if (payload.truncated && typeof payload.preview === 'string') {
    const inner = tryParseJson(payload.preview);
    if (inner !== null && isRecord(inner)) {
      return summarizeHarnessPayload(inner);
    }
  }
  return summarizeHarnessPayload(payload);
}

function summarizeHarnessPayload(payload: Record<string, unknown>): string | null {
  if (payload.type === 'message_update' && isRecord(payload.message)) {
    return summarizeMessageContent(payload.message.content);
  }
  if (payload.type === 'tool_end' || payload.type === 'tool_start') {
    const name = typeof payload.toolName === 'string' ? payload.toolName : null;
    if (payload.type === 'tool_end' && 'result' in payload) {
      return name
        ? `${name} → ${summarizeToolResult(payload.result)}`
        : summarizeToolResult(payload.result);
    }
    if (payload.type === 'tool_start' && name) {
      return `${name}(${JSON.stringify(payload.args ?? {}).slice(0, 80)})`;
    }
  }
  return null;
}

export interface TimelineEntry {
  kind: 'tool_call' | 'tool_result' | 'text' | 'reasoning' | 'error' | 'info';
  label: string;
  detail?: string;
  isError?: boolean;
}

/** Extract a structured timeline from harness message content or tool events. */
export function buildEventTimeline(event: {
  eventType: string;
  name: string;
  toolId: string | null;
  inputPreview: string | null;
  outputPreview: string | null;
  payload: Record<string, unknown>;
  errorText: string | null;
}): TimelineEntry[] {
  const entries: TimelineEntry[] = [];

  if (event.errorText) {
    entries.push({ kind: 'error', label: event.errorText });
  }

  const payload = unwrapPayload(event.payload);

  if (payload.type === 'message_update' && isRecord(payload.message)) {
    const content = payload.message.content;
    if (Array.isArray(content)) {
      for (const part of content as MessageContentPart[]) {
        if (part.type === 'tool_call' && part.name) {
          const args =
            part.args && Object.keys(part.args as object).length > 0
              ? JSON.stringify(part.args)
              : undefined;
          entries.push({
            kind: 'tool_call',
            label: part.name,
            detail: args && args.length > 120 ? `${args.slice(0, 120)}…` : args,
          });
        } else if (part.type === 'tool_result' && part.name) {
          entries.push({
            kind: 'tool_result',
            label: part.name,
            detail: summarizeToolResult(part.result),
            isError: part.isError,
          });
        } else if (part.type === 'text' && part.text?.trim()) {
          entries.push({ kind: 'text', label: part.text.trim() });
        }
      }
    }
    return entries;
  }

  if (event.eventType === 'tool_call_start' || payload.type === 'tool_start') {
    const name = event.toolId ?? event.name;
    const args = event.inputPreview ?? (payload.args ? JSON.stringify(payload.args) : undefined);
    entries.push({
      kind: 'tool_call',
      label: name,
      detail: args && args.length > 200 ? `${args.slice(0, 200)}…` : args,
    });
    return entries;
  }

  if (event.eventType === 'tool_call_result' || payload.type === 'tool_end') {
    const name = event.toolId ?? event.name;
    const result = event.outputPreview
      ? tryParseJson(event.outputPreview) ?? event.outputPreview
      : payload.result;
    entries.push({
      kind: 'tool_result',
      label: name,
      detail: summarizeToolResult(result),
      isError: event.errorText != null,
    });
    return entries;
  }

  if (event.eventType === 'usage_update') {
    entries.push({
      kind: 'info',
      label: 'Token usage',
      detail: event.outputPreview ?? undefined,
    });
    return entries;
  }

  if (isModelStepEvent(event.eventType, event.name)) {
    const step = extractModelStepOutput(payload);
    if (step) {
      const metaParts: string[] = [];
      if (step.stepIndex != null) metaParts.push(`Step ${step.stepIndex}`);
      if (step.finishReason) metaParts.push(`finish: ${step.finishReason}`);
      if (step.outputTokens != null) metaParts.push(`${step.outputTokens} output tok`);
      if (metaParts.length > 0) {
        entries.push({ kind: 'info', label: metaParts.join(' · ') });
      }

      for (const call of step.toolCalls) {
        const name = call.toolName ?? call.name ?? 'tool';
        const args =
          call.args && Object.keys(call.args as object).length > 0
            ? JSON.stringify(call.args)
            : undefined;
        entries.push({
          kind: 'tool_call',
          label: name,
          detail: args && args.length > 200 ? `${args.slice(0, 200)}…` : args,
        });
      }

      if (step.text?.trim()) {
        entries.push({
          kind: 'text',
          label: 'Response',
          detail: step.text.trim(),
        });
      } else if (step.toolCalls.length === 0) {
        entries.push({ kind: 'info', label: 'No text or tool calls in step output' });
      }

      return entries;
    }
  }

  if (isModelInferenceEvent(event.eventType, event.name)) {
    const summary = extractModelInferenceSummary(payload, event.name);
    if (summary) {
      const metaParts = ['Provider call (latency only)'];
      if (summary.finishReason) metaParts.push(`finish: ${summary.finishReason}`);
      if (summary.outputTokens != null) metaParts.push(`${summary.outputTokens} output tok`);
      if (summary.inputTokens != null) metaParts.push(`${summary.inputTokens} input tok`);
      entries.push({ kind: 'info', label: metaParts.join(' · ') });
      entries.push({
        kind: 'info',
        label: 'Response text is on the sibling model_step event with the same step index',
      });
      return entries;
    }
  }

  if (isModelChunkEvent(event.eventType, event.name)) {
    const chunk = extractModelChunkOutput(payload, event.name);
    if (chunk) {
      if (chunk.chunkType === 'reasoning' && chunk.text?.trim()) {
        entries.push({
          kind: 'reasoning',
          label: 'Reasoning',
          detail: chunk.text.trim(),
        });
      } else if (chunk.chunkType === 'text' && chunk.text?.trim()) {
        entries.push({
          kind: 'text',
          label: 'Streamed text',
          detail: chunk.text.trim(),
        });
      } else if (chunk.chunkType.startsWith('tool')) {
        entries.push({
          kind: 'tool_call',
          label: `Chunk: ${chunk.chunkType}`,
          detail: chunk.text?.trim(),
        });
      } else {
        entries.push({
          kind: 'info',
          label: `Chunk: ${chunk.chunkType}`,
          detail: chunk.text?.trim(),
        });
      }
      return entries;
    }
  }

  if (event.outputPreview) {
    const parsed = tryParseJson(event.outputPreview);
    entries.push({
      kind: 'info',
      label: 'Output',
      detail: parsed !== null ? summarizeToolResult(parsed) : summarizeTextResult(event.outputPreview),
    });
  } else if (event.inputPreview) {
    entries.push({
      kind: 'info',
      label: 'Input',
      detail: summarizeTextResult(event.inputPreview),
    });
  }

  return entries;
}

function unwrapPayload(payload: Record<string, unknown>): Record<string, unknown> {
  if (payload.truncated && typeof payload.preview === 'string') {
    const inner = tryParseJson(payload.preview) ?? balanceAndParseJson(payload.preview);
    if (inner !== null && isRecord(inner)) return inner;
  }
  return payload;
}

// --- Mastra model span helpers ---

export interface ModelStepToolCall {
  toolCallId?: string;
  toolName?: string;
  name?: string;
  args?: unknown;
}

export interface ModelStepOutput {
  text?: string;
  toolCalls: ModelStepToolCall[];
  finishReason?: string;
  stepIndex?: number;
  reasoningTokens?: number;
  outputTokens?: number;
  inputMessages?: PromptMessage[];
}

export interface ModelInferenceSummary {
  stepIndex?: number;
  finishReason?: string;
  isLatencyOnly: true;
  outputTokens?: number;
  inputTokens?: number;
  completionStartTime?: string;
  availableToolCount?: number;
}

export interface ModelChunkOutput {
  chunkType: string;
  text?: string;
}

export interface PromptMessage {
  role: string;
  content: string;
}

function parseStepIndexFromName(name: string): number | undefined {
  const stepMatch = name.match(/^step:\s*(\d+)$/);
  if (stepMatch) return parseInt(stepMatch[1], 10);
  const inferenceMatch = name.match(/^inference:\s*(\d+)$/);
  if (inferenceMatch) return parseInt(inferenceMatch[1], 10);
  return undefined;
}

function parseChunkTypeFromName(name: string): string | undefined {
  const match = name.match(/^chunk:\s*'([^']+)'$/);
  return match?.[1];
}

export function isModelStepEvent(eventType: string, name: string): boolean {
  return eventType === 'model_step' || /^step:\s*\d+$/.test(name);
}

export function isModelInferenceEvent(eventType: string, name: string): boolean {
  return eventType === 'model_inference' || /^inference:\s*\d+$/.test(name);
}

export function isModelChunkEvent(eventType: string, name: string): boolean {
  return eventType === 'model_chunk' || /^chunk:\s*'/.test(name);
}

function readUsageTokens(attrs: Record<string, unknown> | undefined): {
  outputTokens?: number;
  reasoningTokens?: number;
  inputTokens?: number;
} {
  if (!attrs) return {};
  const usage = attrs.usage;
  if (!isRecord(usage)) return {};
  const outputTokens =
    typeof usage.outputTokens === 'number' ? usage.outputTokens : undefined;
  const reasoningTokens =
    typeof usage.reasoningTokens === 'number'
      ? usage.reasoningTokens
      : isRecord(usage.outputTokens) && typeof usage.outputTokens.reasoning === 'number'
        ? usage.outputTokens.reasoning
        : isRecord(usage.raw) &&
            isRecord(usage.raw.outputTokens) &&
            typeof usage.raw.outputTokens.reasoning === 'number'
          ? usage.raw.outputTokens.reasoning
          : undefined;
  const inputTokens =
    typeof usage.inputTokens === 'number' ? usage.inputTokens : undefined;
  return { outputTokens, reasoningTokens, inputTokens };
}

function normalizeToolCalls(raw: unknown): ModelStepToolCall[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(isRecord)
    .map((call) => ({
      toolCallId: typeof call.toolCallId === 'string' ? call.toolCallId : undefined,
      toolName:
        typeof call.toolName === 'string'
          ? call.toolName
          : typeof call.name === 'string'
            ? call.name
            : undefined,
      name: typeof call.name === 'string' ? call.name : undefined,
      args: call.args,
    }))
    .filter((call) => call.toolName ?? call.name);
}

function normalizePromptMessages(raw: unknown): PromptMessage[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(isRecord)
    .map((msg) => ({
      role: typeof msg.role === 'string' ? msg.role : 'unknown',
      content:
        typeof msg.content === 'string'
          ? msg.content
          : Array.isArray(msg.content)
            ? JSON.stringify(msg.content)
            : '',
    }));
}

export function extractModelStepOutput(payload: Record<string, unknown>): ModelStepOutput | null {
  const unwrapped = unwrapPayload(payload);
  const output = unwrapped.output;
  if (!isRecord(output) && !Array.isArray(unwrapped.input)) return null;

  const attrs = isRecord(unwrapped.attributes) ? unwrapped.attributes : undefined;
  const tokens = readUsageTokens(attrs);
  const text = isRecord(output) && typeof output.text === 'string' ? output.text : undefined;
  const toolCalls = isRecord(output) ? normalizeToolCalls(output.toolCalls) : [];
  const finishReason =
    attrs && typeof attrs.finishReason === 'string' ? attrs.finishReason : undefined;
  const stepIndex =
    attrs && typeof attrs.stepIndex === 'number'
      ? attrs.stepIndex
      : parseStepIndexFromName(
          typeof unwrapped.name === 'string' ? unwrapped.name : '',
        );

  const inputMessages = normalizePromptMessages(unwrapped.input);

  if (
    !text?.trim() &&
    toolCalls.length === 0 &&
    inputMessages.length === 0 &&
    finishReason === undefined &&
    stepIndex === undefined
  ) {
    return null;
  }

  return {
    text,
    toolCalls,
    finishReason,
    stepIndex,
    reasoningTokens: tokens.reasoningTokens,
    outputTokens: tokens.outputTokens,
    inputMessages: inputMessages.length > 0 ? inputMessages : undefined,
  };
}

export function extractModelInferenceSummary(
  payload: Record<string, unknown>,
  name: string,
): ModelInferenceSummary | null {
  const unwrapped = unwrapPayload(payload);
  const attrs = isRecord(unwrapped.attributes) ? unwrapped.attributes : undefined;
  const tokens = readUsageTokens(attrs);
  const finishReason =
    attrs && typeof attrs.finishReason === 'string' ? attrs.finishReason : undefined;
  const stepIndex =
    attrs && typeof attrs.stepIndex === 'number' ? attrs.stepIndex : parseStepIndexFromName(name);
  const completionStartTime =
    attrs && typeof attrs.completionStartTime === 'string'
      ? attrs.completionStartTime
      : undefined;
  const availableTools = attrs?.availableTools;
  const availableToolCount = Array.isArray(availableTools) ? availableTools.length : undefined;

  if (
    stepIndex === undefined &&
    finishReason === undefined &&
    tokens.outputTokens === undefined &&
    tokens.inputTokens === undefined
  ) {
    return null;
  }

  return {
    stepIndex,
    finishReason,
    isLatencyOnly: true,
    outputTokens: tokens.outputTokens,
    inputTokens: tokens.inputTokens,
    completionStartTime,
    availableToolCount,
  };
}

export function extractModelChunkOutput(
  payload: Record<string, unknown>,
  name: string,
): ModelChunkOutput | null {
  const unwrapped = unwrapPayload(payload);
  const attrs = isRecord(unwrapped.attributes) ? unwrapped.attributes : undefined;
  const chunkType =
    (attrs && typeof attrs.chunkType === 'string' ? attrs.chunkType : undefined) ??
    parseChunkTypeFromName(name) ??
    'unknown';

  const output = unwrapped.output;
  let text: string | undefined;
  if (typeof output === 'string') {
    text = output;
  } else if (isRecord(output) && typeof output.text === 'string') {
    text = output.text;
  }

  if (!text?.trim() && chunkType === 'unknown') return null;

  return { chunkType, text };
}

export function summarizeModelStepPreview(step: ModelStepOutput): string {
  const toolNames = step.toolCalls
    .map((c) => c.toolName ?? c.name)
    .filter((n): n is string => Boolean(n));

  if (toolNames.length > 0) {
    const unique = [...new Set(toolNames)];
    const suffix = unique.length > 3 ? ` +${unique.length - 3} more` : '';
    return `${toolNames.length} tool call${toolNames.length === 1 ? '' : 's'}: ${unique.slice(0, 3).join(', ')}${suffix}`;
  }

  if (step.text?.trim()) {
    const firstLine = step.text.trim().split('\n').find((line) => line.trim()) ?? step.text.trim();
    const cleaned = firstLine.replace(/^\*\*|\*\*$/g, '').trim();
    return cleaned.length > 120 ? `${cleaned.slice(0, 120)}…` : cleaned;
  }

  if (step.finishReason) return `finish: ${step.finishReason}`;
  return 'Model step';
}

export function summarizePromptMessage(content: string, maxChars = 120): string {
  const trimmed = content.trim();
  if (!trimmed) return '(empty)';
  const oneLine = trimmed.replace(/\s+/g, ' ');
  return oneLine.length > maxChars ? `${oneLine.slice(0, maxChars)}…` : oneLine;
}

/** Pretty-print JSON for display, parsing nested JSON strings (e.g. payload.preview). */
export function formatPayloadForDisplay(payload: Record<string, unknown>): {
  isTruncated: boolean;
  json: string;
  previewFormatted?: string;
} {
  const isTruncated = Boolean(payload.truncated);
  const normalized = normalizeJsonDeep(payload) as Record<string, unknown>;

  // Surface formatted partial preview as a separate block when present.
  let previewFormatted: string | undefined;
  if (typeof payload.preview === 'string' && looksLikeJson(payload.preview)) {
    const formatted = stringifyPreviewField(payload.preview, 0);
    if (formatted) previewFormatted = formatted;
  }

  // Drop duplicate _formatted helper keys from main tree when we show preview separately.
  const forMain = { ...normalized };
  if (previewFormatted && typeof forMain.preview_formatted === 'string') {
    delete forMain.preview_formatted;
  }

  try {
    return {
      isTruncated,
      json: JSON.stringify(forMain, null, 2),
      previewFormatted:
        previewFormatted && typeof normalized.preview !== 'object'
          ? previewFormatted
          : undefined,
    };
  } catch {
    return { isTruncated, json: String(payload) };
  }
}

/** Pretty-print a preview or output string when it contains JSON. */
export function formatJsonText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return text;
  const parsed = tryParseJson(trimmed) ?? balanceAndParseJson(trimmed);
  if (parsed !== null) return JSON.stringify(normalizeJsonDeep(parsed), null, 2);
  if (looksLikeJson(trimmed)) return prettyPrintJsonFragment(trimmed);
  return text;
}

export function shortId(id: string, chars = 8): string {
  return id.length > chars ? `${id.slice(0, chars)}…` : id;
}
