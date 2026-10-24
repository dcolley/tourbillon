/**
 * CHAT-1: POST /api/agui/[agentId]/attachments — upload one composer attachment to the company
 * workspace (the files agents read today), for a message to the agent.
 *
 * Same auth and company scope as the AG-UI endpoint: board session with an active company (agent
 * tokens are refused), agent resolved within the active company. Query `threadId` (optional): must
 * be one of the agent's threads (404 otherwise, as on the AG-UI endpoint); checked before the body
 * is read. Multipart form: `file` (required).
 *
 * Checks (lib/chat-attachments): allow-listed extension, blocked executable / script / web types,
 * size limit (refused from Content-Length before the body is read; otherwise counted while the body
 * streams and aborted past the limit), and content that matches the extension. Stored at
 * resources/chat-uploads/{agent}/{thread}/{unique}-{name} with a time + random prefix, written
 * exclusively and without following links (saveWorkspaceUpload → writeWorkspaceFileSafe).
 *
 * 201 → { path, name, size, mediaType }. 400 invalid / refused type, 413 too large.
 */
import { randomBytes } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { ChatAgentError, getOrCreateChatController, resolveChatAgent } from '@/lib/chat';
import { chatErrorResponse } from '@/lib/chat/route-helpers';
import { saveWorkspaceUpload, WorkspacePathError, WorkspaceSizeError } from '@/lib/company-workspace';
import { readLimitedFormData } from '@/lib/limited-form-data';
import {
  CHAT_ATTACHMENT_MAX_BYTES,
  attachmentDisplayName,
  chatAttachmentDir,
  checkChatAttachment,
  storedAttachmentName,
  verifyAttachmentBytes,
  type ChatAttachmentRef,
} from '@/lib/chat-attachments';

/** Multipart overhead allowed on top of the file itself. */
const FORM_OVERHEAD_BYTES = 64 * 1024;
const THREAD_ID_RE = /^[A-Za-z0-9._:-]{1,200}$/;

type Agent = Awaited<ReturnType<typeof resolveChatAgent>>;

function refuse(status: number, error: string, code?: string) {
  return NextResponse.json({ error, ...(code ? { code } : {}) }, { status });
}

/** Same rule as the AG-UI endpoint: the thread exists, is in the agent's company and is the agent's. */
async function assertAgentThread(agent: Agent, threadId: string) {
  const controller = await getOrCreateChatController(agent);
  const thread = await controller.queryThreadById({ threadId });
  const owner = (thread?.metadata as Record<string, unknown> | null | undefined)?.agentId;
  if (!thread || !String(thread.resourceId ?? '').startsWith(`company-${agent.companyId}:chat:`) || owner !== agent.id) {
    throw new ChatAgentError('Thread not found', 404);
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ agentId: string }> }) {
  try {
    const { agentId: agentKey } = await params;
    // Auth, company scope and thread ownership before the body is read.
    const agent = await resolveChatAgent(agentKey);
    const threadRaw = req.nextUrl.searchParams.get('threadId');
    const threadId = threadRaw && threadRaw.trim() ? threadRaw.trim() : null;
    if (threadId) {
      if (!THREAD_ID_RE.test(threadId)) return refuse(400, 'Invalid threadId.');
      await assertAgentThread(agent, threadId);
    }

    // Counted while streaming: refused (413) as soon as it passes the limit, never fully buffered.
    const body = await readLimitedFormData(req, CHAT_ATTACHMENT_MAX_BYTES + FORM_OVERHEAD_BYTES);
    if (!body.ok) {
      return body.reason === 'too_large'
        ? refuse(413, 'The file is over the upload limit.', 'too_large')
        : refuse(400, 'Expected a multipart form with a file.');
    }
    const form = body.form;
    const file = form.get('file');
    if (!(file instanceof File)) return refuse(400, 'file is required.');
    if (form.getAll('file').length > 1) return refuse(400, 'Upload one file per request.');
    if (form.has('threadId')) return refuse(400, 'Pass threadId in the query string.');

    const check = checkChatAttachment({ name: file.name, size: file.size, type: file.type });
    if (!check.ok) return refuse(check.code === 'too_large' ? 413 : 400, check.message, check.code);

    const bytes = new Uint8Array(await file.arrayBuffer());
    const verified = verifyAttachmentBytes(file.name, check.ext, bytes);
    if (!verified.ok) return refuse(verified.code === 'too_large' ? 413 : 400, verified.message, verified.code);

    const unique = `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
    const relativePath = `${chatAttachmentDir(agent.urlKey ?? agent.id, threadId)}/${unique}-${storedAttachmentName(file.name, check.ext)}`;
    let saved: { path: string; size: number };
    try {
      // Exclusive, no-follow write inside the real company workspace (never replaces a file).
      saved = await saveWorkspaceUpload(agent.companyId, relativePath, Buffer.from(bytes), { exclusive: true });
    } catch (err) {
      if (err instanceof WorkspaceSizeError) return refuse(413, err.message, 'too_large');
      if (err instanceof WorkspacePathError) return refuse(400, err.message);
      throw err;
    }
    const result: ChatAttachmentRef = {
      path: saved.path,
      name: attachmentDisplayName(file.name),
      size: saved.size,
      // From the extension allow-list, never the browser-reported type.
      mediaType: check.mediaType,
    };
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return chatErrorResponse(err);
  }
}
