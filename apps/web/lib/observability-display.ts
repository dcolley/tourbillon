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
  kind: 'tool_call' | 'tool_result' | 'text' | 'error' | 'info';
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
