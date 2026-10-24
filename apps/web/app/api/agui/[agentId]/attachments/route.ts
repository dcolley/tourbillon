/**
 * CHAT-1: POST /api/agui/[agentId]/attachments — upload one composer attachment to the company
 * workspace (the files agents read today), for a message to the agent.
 *
 * Same auth and company scope as the AG-UI endpoint: board session with an active company (agent
 * tokens are refused), agent resolved within the active company. Multipart form: `file` (required),
 * `threadId` (optional, only names the folder).
 *
 * Checks (lib/chat-attachments): allow-listed extension, blocked executable / script / web types,
 * size limit (refused from Content-Length before the body is read when possible), and content that
 * matches the extension. Stored at resources/chat-uploads/{agent}/{thread}/{unique}-{name}, with a
 * time + random prefix per upload so uploads do not replace each other.
 *
 * 201 → { path, name, size, mediaType }. 400 invalid / refused type, 413 too large.
 */
import { randomBytes } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { resolveChatAgent } from '@/lib/chat';
import { chatErrorResponse } from '@/lib/chat/route-helpers';
import { saveWorkspaceUpload, WorkspacePathError, WorkspaceSizeError } from '@/lib/company-workspace';
import {
  CHAT_ATTACHMENT_MAX_BYTES,
  attachmentContentMatches,
  attachmentDisplayName,
  chatAttachmentDir,
  checkChatAttachment,
  storedAttachmentName,
  type ChatAttachmentRef,
} from '@/lib/chat-attachments';

/** Multipart overhead allowed on top of the file itself. */
const FORM_OVERHEAD_BYTES = 64 * 1024;
const THREAD_ID_RE = /^[A-Za-z0-9._:-]{1,200}$/;

function refuse(status: number, error: string, code?: string) {
  return NextResponse.json({ error, ...(code ? { code } : {}) }, { status });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ agentId: string }> }) {
  try {
    const { agentId: agentKey } = await params;
    // Auth + company scope before reading the body.
    const agent = await resolveChatAgent(agentKey);

    const declared = Number(req.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > CHAT_ATTACHMENT_MAX_BYTES + FORM_OVERHEAD_BYTES) {
      return refuse(413, 'The file is over the upload limit.', 'too_large');
    }

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return refuse(400, 'Expected a multipart form with a file.');
    }
    const file = form.get('file');
    if (!(file instanceof File)) return refuse(400, 'file is required.');
    if (form.getAll('file').length > 1) return refuse(400, 'Upload one file per request.');
    const threadRaw = form.get('threadId');
    const threadId = typeof threadRaw === 'string' && threadRaw.trim() ? threadRaw.trim() : null;
    if (threadId && !THREAD_ID_RE.test(threadId)) return refuse(400, 'Invalid threadId.');

    const check = checkChatAttachment({ name: file.name, size: file.size, type: file.type });
    if (!check.ok) return refuse(check.code === 'too_large' ? 413 : 400, check.message, check.code);

    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.length > CHAT_ATTACHMENT_MAX_BYTES) return refuse(413, 'The file is over the upload limit.', 'too_large');
    if (!attachmentContentMatches(check.ext, bytes)) {
      return refuse(400, `${attachmentDisplayName(file.name)}: the content does not match a .${check.ext} file.`, 'content_mismatch');
    }

    const unique = `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
    const relativePath = `${chatAttachmentDir(agent.urlKey ?? agent.id, threadId)}/${unique}-${storedAttachmentName(file.name, check.ext)}`;
    let saved: { path: string; size: number };
    try {
      saved = await saveWorkspaceUpload(agent.companyId, relativePath, Buffer.from(bytes));
    } catch (err) {
      if (err instanceof WorkspaceSizeError) return refuse(413, err.message, 'too_large');
      if (err instanceof WorkspacePathError) return refuse(400, err.message);
      throw err;
    }
    const body: ChatAttachmentRef = {
      path: saved.path,
      name: attachmentDisplayName(file.name),
      size: saved.size,
      mediaType: check.mediaType,
    };
    return NextResponse.json(body, { status: 201 });
  } catch (err) {
    return chatErrorResponse(err);
  }
}
