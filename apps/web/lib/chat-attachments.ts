/**
 * CHAT-1: rules for files attached in the assistant composer, shared by the composer (client) and
 * the upload route (server). Pure: no Node or DOM APIs.
 *
 * - Allow-list by extension. Everything else is refused, with a specific message for executables and
 *   scripts. The media type comes from the extension, not from the browser's guess.
 * - Size: at most CHAT_ATTACHMENT_MAX_BYTES per file (the company workspace upload limit) and
 *   CHAT_ATTACHMENT_MAX_FILES per message.
 * - The server also checks the content matches the extension (magic bytes for images, PDF and
 *   Office files; no NUL bytes in text files) — see attachmentContentMatches.
 * - Uploads land in the company workspace (the files agents read today) under
 *   resources/chat-uploads/{agent}/{thread}/; the message tells the agent the paths.
 */
import { WORKSPACE_MAX_UPLOAD_BYTES } from '@tourbillon/shared/company-workspace-types';

export const CHAT_ATTACHMENT_MAX_BYTES = WORKSPACE_MAX_UPLOAD_BYTES;
export const CHAT_ATTACHMENT_MAX_FILES = 10;
/** Workspace folder for chat uploads (inside the PARA `resources/` dir). */
export const CHAT_UPLOADS_DIR = 'resources/chat-uploads';

export type ChatAttachmentKind = 'image' | 'pdf' | 'office' | 'text';

interface AllowedType {
  kind: ChatAttachmentKind;
  mediaType: string;
}

const ALLOWED: Record<string, AllowedType> = {
  png: { kind: 'image', mediaType: 'image/png' },
  jpg: { kind: 'image', mediaType: 'image/jpeg' },
  jpeg: { kind: 'image', mediaType: 'image/jpeg' },
  gif: { kind: 'image', mediaType: 'image/gif' },
  webp: { kind: 'image', mediaType: 'image/webp' },
  pdf: { kind: 'pdf', mediaType: 'application/pdf' },
  docx: { kind: 'office', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  xlsx: { kind: 'office', mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  pptx: { kind: 'office', mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
  txt: { kind: 'text', mediaType: 'text/plain' },
  md: { kind: 'text', mediaType: 'text/markdown' },
  csv: { kind: 'text', mediaType: 'text/csv' },
  tsv: { kind: 'text', mediaType: 'text/tab-separated-values' },
  json: { kind: 'text', mediaType: 'application/json' },
  jsonl: { kind: 'text', mediaType: 'application/jsonl' },
  yaml: { kind: 'text', mediaType: 'application/yaml' },
  yml: { kind: 'text', mediaType: 'application/yaml' },
  xml: { kind: 'text', mediaType: 'application/xml' },
  log: { kind: 'text', mediaType: 'text/plain' },
};

/** Refused with a specific message (executables, scripts, installers, active content). */
const BLOCKED = new Set([
  'exe', 'dll', 'com', 'scr', 'msi', 'msp', 'bat', 'cmd', 'ps1', 'psm1', 'vbs', 'vbe', 'js', 'mjs', 'cjs', 'jse',
  'wsf', 'wsh', 'hta', 'cpl', 'jar', 'app', 'dmg', 'pkg', 'deb', 'rpm', 'apk', 'iso', 'sh', 'bash', 'zsh', 'command',
  'bin', 'so', 'dylib', 'lnk', 'reg', 'html', 'htm', 'xhtml', 'svg', 'docm', 'xlsm', 'pptm',
]);

/** Browser-reported types that are refused whatever the extension says. */
const BLOCKED_MEDIA_TYPES = [
  'application/x-msdownload',
  'application/x-msdos-program',
  'application/x-executable',
  'application/x-sh',
  'application/x-elf',
  'application/vnd.microsoft.portable-executable',
  'text/html',
  'image/svg+xml',
];

export const CHAT_ATTACHMENT_EXTENSIONS: readonly string[] = Object.keys(ALLOWED);
/** For `<input type="file" accept>`. */
export const CHAT_ATTACHMENT_ACCEPT = CHAT_ATTACHMENT_EXTENSIONS.map((e) => `.${e}`).join(',');

export type ChatAttachmentRefusal = 'empty' | 'too_large' | 'blocked_type' | 'unsupported_type' | 'too_many';

export type ChatAttachmentCheck =
  | { ok: true; ext: string; kind: ChatAttachmentKind; mediaType: string }
  | { ok: false; code: ChatAttachmentRefusal; message: string };

export function attachmentExtension(name: string): string {
  const base = name.trim().split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
  return `${Math.round((bytes / 1048576) * 10) / 10} MB`;
}

function groupDigits(n: number): string {
  return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** "{name}: 12.5 MB is over the 10 MB limit." — with exact bytes when the rounded sizes look equal. */
export function tooLargeMessage(name: string, size: number, max = CHAT_ATTACHMENT_MAX_BYTES): string {
  const shown = formatBytes(size);
  const limit = formatBytes(max);
  if (shown === limit) {
    return `${name}: ${groupDigits(size)} bytes is over the ${limit} limit (${groupDigits(max)} bytes).`;
  }
  return `${name}: ${shown} is over the ${limit} limit.`;
}

/** Display name for messages and errors: one line, bounded. */
export function attachmentDisplayName(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return (base || 'file').slice(0, 120);
}

/** Checks one file's name, size and reported type (client before upload; server again on receipt). */
export function checkChatAttachment(file: { name: string; size: number; type?: string }): ChatAttachmentCheck {
  const name = attachmentDisplayName(file.name);
  const ext = attachmentExtension(file.name);
  const reported = (file.type ?? '').toLowerCase().split(';')[0].trim();
  if (BLOCKED.has(ext) || BLOCKED_MEDIA_TYPES.includes(reported)) {
    return {
      ok: false,
      code: 'blocked_type',
      message: `${name}: ${ext ? `.${ext} files` : 'this file type'} can't be attached (executables, scripts and web pages are blocked).`,
    };
  }
  const allowed = ALLOWED[ext];
  if (!allowed) {
    return {
      ok: false,
      code: 'unsupported_type',
      message: `${name}: ${ext ? `.${ext} files aren't supported` : 'files without an extension aren\'t supported'}. Allowed: images, PDF, Office documents and text files.`,
    };
  }
  if (!Number.isFinite(file.size) || file.size <= 0) {
    return { ok: false, code: 'empty', message: `${name}: the file is empty.` };
  }
  if (file.size > CHAT_ATTACHMENT_MAX_BYTES) {
    return { ok: false, code: 'too_large', message: tooLargeMessage(name, file.size) };
  }
  return { ok: true, ext, kind: allowed.kind, mediaType: allowed.mediaType };
}

function startsWith(bytes: Uint8Array, sig: number[], offset = 0): boolean {
  if (bytes.length < offset + sig.length) return false;
  return sig.every((b, i) => bytes[offset + i] === b);
}

/** Server-side: does the content look like the extension says? */
export function attachmentContentMatches(ext: string, bytes: Uint8Array): boolean {
  const type = ALLOWED[ext];
  if (!type) return false;
  switch (ext) {
    case 'png':
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'jpg':
    case 'jpeg':
      return startsWith(bytes, [0xff, 0xd8, 0xff]);
    case 'gif':
      return startsWith(bytes, [0x47, 0x49, 0x46, 0x38]);
    case 'webp':
      return startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8);
    case 'pdf':
      return startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]);
    default:
      break;
  }
  if (type.kind === 'office') return startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]);
  // Text: no NUL bytes in the first 64 KiB.
  const head = bytes.subarray(0, 64 * 1024);
  return !head.includes(0);
}

export type AttachmentBytesCheck =
  | { ok: true }
  | { ok: false; code: 'too_large' | 'content_mismatch'; message: string };

/** Server-side check of the bytes actually received (length and content). */
export function verifyAttachmentBytes(name: string, ext: string, bytes: Uint8Array): AttachmentBytesCheck {
  const display = attachmentDisplayName(name);
  if (bytes.byteLength > CHAT_ATTACHMENT_MAX_BYTES) {
    return { ok: false, code: 'too_large', message: tooLargeMessage(display, bytes.byteLength) };
  }
  if (!attachmentContentMatches(ext, bytes)) {
    return { ok: false, code: 'content_mismatch', message: `${display}: the content does not match a .${ext} file.` };
  }
  return { ok: true };
}

/** One workspace path segment: letters, digits, `.`, `_`, `-`; starts with a letter or digit. */
export function workspaceSegment(value: string, fallback: string, max = 80): string {
  const cleaned = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/\.{2,}/g, '.');
  const out = cleaned.slice(0, max).replace(/[._-]+$/, '');
  return out || fallback;
}

/** Stored file name: sanitized base name with the (allowed) extension kept. */
export function storedAttachmentName(name: string, ext: string): string {
  const display = attachmentDisplayName(name);
  const base = display.slice(0, display.length - (ext ? ext.length + 1 : 0));
  return `${workspaceSegment(base, 'file', 80)}.${ext}`;
}

/** Workspace folder for one agent's chat uploads in one thread. */
export function chatAttachmentDir(agentKey: string, threadId?: string | null): string {
  return `${CHAT_UPLOADS_DIR}/${workspaceSegment(agentKey, 'agent')}/${threadId ? workspaceSegment(threadId, 'thread', 120) : 'new-thread'}`;
}

/** What the upload route returns and the composer sends. */
export interface ChatAttachmentRef {
  /** Path relative to the company workspace root. */
  path: string;
  name: string;
  size: number;
  mediaType: string;
}

/**
 * The message text sent to the agent: the user's text, then the attachments as workspace paths the
 * agent can open with its workspace tools.
 */
export function messageWithAttachments(text: string, attachments: readonly ChatAttachmentRef[]): string {
  const body = text.trim();
  if (attachments.length === 0) return body;
  const lines = attachments.map((a) => `- ${a.path} (${attachmentDisplayName(a.name)}, ${a.mediaType}, ${formatBytes(a.size)})`);
  const note = `[Attached files, saved in the company workspace]\n${lines.join('\n')}`;
  return body ? `${body}\n\n${note}` : note;
}
