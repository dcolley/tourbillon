/**
 * CHAT-1: POST /api/agui/[agentId]/attachments — composer uploads into the company workspace.
 *
 * '@/lib/chat' is mocked only at agent resolution and thread lookup (same outcomes as the AG-UI
 * route: no active company / agent token → ActiveCompanyError, other company's agent → 404, thread
 * not the agent's → 404). The workspace is real, rooted in a temp directory.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { CHAT_ATTACHMENT_MAX_BYTES } from '@/lib/chat-attachments';

type Handler = (req: NextRequest, ctx: { params: Promise<{ agentId: string }> }) => Promise<Response>;

const AGENT = { id: 'agent-a', urlKey: 'alice', name: 'Alice', companyId: 'company-a', modelId: 'm' };
const ODD = { id: 'agent-odd', urlKey: 'Al!ce/..', name: 'Odd', companyId: 'company-a', modelId: 'm' };
const CAROL = { id: 'agent-c', urlKey: 'carol', name: 'Carol', companyId: 'company-a', modelId: 'm' };
const AGENTS = [AGENT, ODD, CAROL];
const own = (agentId = AGENT.id, companyId = AGENT.companyId) => ({
  resourceId: `company-${companyId}:chat:user-1`,
  metadata: { agentId },
});
const THREADS: Record<string, { resourceId: string; metadata: Record<string, unknown> }> = {
  'thread-1': own(),
  'thread-2': own(),
  'thread.v2:x': own(),
  'other-agent': own('agent-z'),
  'other-company': own(AGENT.id, 'company-b'),
  'no-owner': { resourceId: 'company-company-a:chat:user-1', metadata: {} },
};
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

class ChatAgentError extends Error {
  constructor(message: string, readonly status = 404) {
    super(message);
  }
}
class ActiveCompanyError extends Error {}

let authMode: 'ok' | 'no-company' | 'agent-token' = 'ok';
let POST: Handler;
let threadLookups = 0;
let root: string;
const prevRoot = process.env.COMPANY_WORKSPACE_ROOT;

function upload(
  agentKey: string,
  form: FormData | string | ReadableStream<Uint8Array>,
  headers: Record<string, string> = {},
  threadId?: string,
) {
  const query = threadId === undefined ? '' : `?threadId=${encodeURIComponent(threadId)}`;
  return POST(
    new NextRequest(`http://localhost/api/agui/${agentKey}/attachments${query}`, {
      method: 'POST',
      body: form,
      headers,
      duplex: 'half',
    } as ConstructorParameters<typeof NextRequest>[1] & { duplex: 'half' }),
    { params: Promise.resolve({ agentId: agentKey }) },
  );
}

function form(file: File | null) {
  const f = new FormData();
  if (file) f.append('file', file, file.name);
  return f;
}

/** A chunked multipart body of about `total` bytes that records how much the route pulled. */
function trackedBody(total: number) {
  const MB = 1024 * 1024;
  const head = new TextEncoder().encode(
    '--XB\r\nContent-Disposition: form-data; name="file"; filename="big.txt"\r\nContent-Type: text/plain\r\n\r\n',
  );
  const stats = { pulled: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (stats.pulled === 0) {
          stats.pulled += head.length;
          controller.enqueue(head);
          return;
        }
        if (stats.pulled >= total) return controller.close();
        stats.pulled += MB;
        controller.enqueue(new Uint8Array(MB).fill(0x61));
      },
      cancel() {
        stats.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, stats, headers: { 'content-type': 'multipart/form-data; boundary=XB' } };
}

describe('CHAT-1 POST /api/agui/[agentId]/attachments', () => {
  let originalRequire: any;

  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'chat1-ws-'));
    process.env.COMPANY_WORKSPACE_ROOT = root;
    const Module = require('module');
    originalRequire = Module.prototype.require;
    Module.prototype.require = function (id: string) {
      if (id === '@/lib/chat' || id.endsWith('/lib/chat') || id.endsWith('/lib/chat/index')) {
        return {
          ChatAgentError,
          getChatSession: async () => {
            throw new Error('not used');
          },
          resolveChatAgent: async (key: string) => {
            if (authMode === 'no-company') throw new ActiveCompanyError('No active company selected');
            if (authMode === 'agent-token') throw new ActiveCompanyError('Agent tokens cannot use board chat');
            const found = AGENTS.find((a) => key === a.id || key === a.urlKey);
            if (found) return found;
            throw new ChatAgentError('Agent not found', 404);
          },
          getOrCreateChatController: async () => ({
            queryThreadById: async ({ threadId }: { threadId: string }) => {
              threadLookups += 1;
              return THREADS[threadId] ?? null;
            },
          }),
        };
      }
      if (id === '@/lib/company' || id.endsWith('/lib/company')) return { ActiveCompanyError };
      return originalRequire.apply(this, arguments as unknown as [string]);
    };
    POST = (await import('./[agentId]/attachments/route')).POST as unknown as Handler;
    Module.prototype.require = originalRequire;
  });

  after(async () => {
    require('module').prototype.require = originalRequire;
    if (prevRoot === undefined) delete process.env.COMPANY_WORKSPACE_ROOT;
    else process.env.COMPANY_WORKSPACE_ROOT = prevRoot;
    await rm(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    authMode = 'ok';
  });

  it('stores the file in the agent company workspace and returns its path', async () => {
    const res = await upload('alice', form(new File([PNG], 'Screen Shot.png', { type: 'image/png' })), {}, 'thread-1');
    assert.equal(res.status, 201);
    const body = (await res.json()) as { path: string; name: string; size: number; mediaType: string };
    assert.match(body.path, /^resources\/chat-uploads\/alice\/thread-1\/[a-z0-9]+-[0-9a-f]{8}-Screen_Shot\.png$/);
    assert.equal(body.name, 'Screen Shot.png');
    assert.equal(body.size, PNG.length);
    assert.equal(body.mediaType, 'image/png');
    const onDisk = await readFile(path.join(root, AGENT.companyId, body.path));
    assert.deepEqual(new Uint8Array(onDisk), PNG);
  });

  it('two uploads of the same name do not replace each other; no thread → new-thread folder', async () => {
    const a = await (await upload('agent-a', form(new File(['one'], 'notes.txt')))).json();
    const b = await (await upload('agent-a', form(new File(['two'], 'notes.txt')))).json();
    assert.notEqual(a.path, b.path);
    assert.match(a.path, /^resources\/chat-uploads\/alice\/new-thread\//);
    const dir = path.join(root, AGENT.companyId, 'resources/chat-uploads/alice/new-thread');
    assert.equal((await readdir(dir)).length, 2);
  });

  it('refuses blocked and unsupported types with a clear message', async () => {
    const exe = await upload('alice', form(new File(['MZ'], 'setup.exe')));
    assert.equal(exe.status, 400);
    const body = await exe.json();
    assert.equal(body.code, 'blocked_type');
    assert.match(body.error, /setup\.exe: \.exe files can't be attached/);

    const sz = await upload('alice', form(new File(['x'], 'a.7z')));
    assert.equal(sz.status, 400);
    assert.equal((await sz.json()).code, 'unsupported_type');

    const empty = await upload('alice', form(new File([], 'a.txt')));
    assert.equal(empty.status, 400);
    assert.equal((await empty.json()).code, 'empty');
  });

  it('refuses content that does not match the extension', async () => {
    const res = await upload('alice', form(new File([new Uint8Array([0x4d, 0x5a, 0, 0])], 'photo.png', { type: 'image/png' })));
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, 'content_mismatch');
    assert.match(body.error, /does not match a \.png file/);
  });

  it('refuses files over the limit (413), before reading the body when Content-Length says so', async () => {
    const big = new File([new Uint8Array(CHAT_ATTACHMENT_MAX_BYTES + 1)], 'big.txt');
    const res = await upload('alice', form(big));
    assert.equal(res.status, 413);
    const body = await res.json();
    assert.equal(body.code, 'too_large');

    const early = await upload('alice', 'x', { 'content-length': String(CHAT_ATTACHMENT_MAX_BYTES * 2) });
    assert.equal(early.status, 413);
  });

  it('validates the form', async () => {
    assert.equal((await upload('alice', form(null))).status, 400);
    assert.equal((await upload('alice', 'not a form', { 'content-type': 'text/plain' })).status, 400);
    const two = form(new File(['a'], 'a.txt'));
    two.append('file', new File(['b'], 'b.txt'));
    assert.equal((await upload('alice', two)).status, 400);
    const badThread = await upload('alice', form(new File(['a'], 'a.txt')), {}, '../../etc');
    assert.equal(badThread.status, 400);
    assert.match((await badThread.json()).error, /threadId/);
    const inForm = form(new File(['a'], 'a.txt'));
    inForm.append('threadId', 'thread-1');
    const formThread = await upload('alice', inForm);
    assert.equal(formThread.status, 400);
    assert.match((await formThread.json()).error, /query string/);
  });

  it('is scoped like the AG-UI endpoint: unknown agent 404, no company / agent token 400', async () => {
    assert.equal((await upload('bob', form(new File(['a'], 'a.txt')))).status, 404);
    authMode = 'no-company';
    assert.equal((await upload('alice', form(new File(['a'], 'a.txt')))).status, 400);
    authMode = 'agent-token';
    const res = await upload('alice', form(new File(['a'], 'a.txt')));
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /Agent tokens/);
  });

  it('the thread must be one of this agent\'s threads in this company (404 otherwise)', async () => {
    for (const threadId of ['unknown', 'other-agent', 'other-company', 'no-owner']) {
      const res = await upload('alice', form(new File(['a'], 'a.txt')), {}, threadId);
      assert.equal(res.status, 404, threadId);
      assert.match((await res.json()).error, /Thread not found/);
    }
    // A thread of this agent's is fine for this agent, not for another agent of the company.
    assert.equal((await upload('carol', form(new File(['a'], 'a.txt')), {}, 'thread-1')).status, 404);
    assert.equal((await upload('alice', form(new File(['a'], 'a.txt')), {}, 'thread-1')).status, 201);
  });

  it('checks auth and the thread before reading the body', async () => {
    authMode = 'no-company';
    const a = trackedBody(50 * 1024 * 1024);
    assert.equal((await upload('alice', a.stream, a.headers)).status, 400);
    assert.equal(a.stats.pulled, 0, 'no body bytes read before auth');
    authMode = 'ok';
    const b = trackedBody(50 * 1024 * 1024);
    assert.equal((await upload('alice', b.stream, b.headers, 'other-agent')).status, 404);
    assert.equal(b.stats.pulled, 0, 'no body bytes read for a refused thread');
    const c = trackedBody(50 * 1024 * 1024);
    assert.equal((await upload('alice', c.stream, c.headers, '../x')).status, 400);
    assert.equal(c.stats.pulled, 0);
    const before = threadLookups;
    await upload('alice', '', {}, '../x');
    assert.equal(threadLookups, before, 'invalid ids are not looked up');
  });

  it('a large body without Content-Length is aborted soon after the limit (413)', async () => {
    const { stream, stats, headers } = trackedBody(512 * 1024 * 1024);
    const res = await upload('alice', stream, headers);
    assert.equal(res.status, 413);
    assert.equal((await res.json()).code, 'too_large');
    assert.ok(stats.pulled < CHAT_ATTACHMENT_MAX_BYTES + 3 * 1024 * 1024, `pulled ${stats.pulled} bytes`);
    assert.equal(stats.cancelled, true);
  });

  it('thread ids and agent keys are sanitised in the stored path', async () => {
    const t = await (await upload('alice', form(new File(['a'], 'a.txt')), {}, 'thread.v2:x')).json();
    assert.match(t.path, /^resources\/chat-uploads\/alice\/thread\.v2_x\/[^/]+-a\.txt$/);
    const o = await (await upload('agent-odd', form(new File(['a'], 'a.txt')))).json();
    assert.match(o.path, /^resources\/chat-uploads\/Al_ce\/new-thread\/[^/]+-a\.txt$/);
    assert.equal(await readFile(path.join(root, AGENT.companyId, o.path), 'utf8'), 'a');
  });

  it('the media type comes from the server allow-list, not the browser', async () => {
    const res = await upload('alice', form(new File([PNG], 'shot.png', { type: 'application/octet-stream' })));
    assert.equal(res.status, 201);
    assert.equal((await res.json()).mediaType, 'image/png');
    const txt = await upload('alice', form(new File(['hi'], 'notes.md', { type: 'text/html' })));
    assert.equal(txt.status, 400, 'a blocked browser type is refused');
    const upper = await upload('alice', form(new File([PNG], 'x.png', { type: 'IMAGE/SVG+XML' })));
    assert.equal(upper.status, 400);
    assert.equal((await upper.json()).code, 'blocked_type');
  });

  it('refuses writes through planted links (thread folder, agent folder) — nothing lands outside', async () => {
    const other = path.join(root, 'company-b', 'resources');
    await mkdir(other, { recursive: true });
    await writeFile(path.join(other, 'keep.md'), 'B');
    const outside = await mkdtemp(path.join(tmpdir(), 'chat1-out-'));
    const uploads = path.join(root, AGENT.companyId, 'resources/chat-uploads');
    await mkdir(path.join(uploads, 'alice'), { recursive: true });
    await symlink(outside, path.join(uploads, 'alice', 'thread-2')); // thread folder → outside
    await symlink(other, path.join(uploads, 'carol')); // agent folder → other company
    try {
      const a = await upload('alice', form(new File(['x'], 'a.txt')), {}, 'thread-2');
      assert.equal(a.status, 400);
      assert.match((await a.json()).error, /escapes/);
      const c = await upload('carol', form(new File(['x'], 'a.txt')));
      assert.equal(c.status, 400);
      assert.deepEqual(await readdir(outside), []);
      assert.deepEqual(await readdir(other), ['keep.md']);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
