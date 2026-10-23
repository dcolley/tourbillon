/**
 * CHAT-1: POST /api/agui/[agentId]/attachments — composer uploads into the company workspace.
 *
 * '@/lib/chat' is mocked only at agent resolution (same outcomes as the AG-UI route: no active
 * company / agent token → ActiveCompanyError, other company's agent → 404). The workspace is real,
 * rooted in a temp directory.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { CHAT_ATTACHMENT_MAX_BYTES } from '@/lib/chat-attachments';

type Handler = (req: NextRequest, ctx: { params: Promise<{ agentId: string }> }) => Promise<Response>;

const AGENT = { id: 'agent-a', urlKey: 'alice', name: 'Alice', companyId: 'company-a', modelId: 'm' };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

class ChatAgentError extends Error {
  constructor(message: string, readonly status = 404) {
    super(message);
  }
}
class ActiveCompanyError extends Error {}

let authMode: 'ok' | 'no-company' | 'agent-token' = 'ok';
let POST: Handler;
let root: string;
const prevRoot = process.env.COMPANY_WORKSPACE_ROOT;

function upload(agentKey: string, form: FormData | string, headers: Record<string, string> = {}) {
  return POST(
    new NextRequest(`http://localhost/api/agui/${agentKey}/attachments`, {
      method: 'POST',
      body: form,
      headers,
    }),
    { params: Promise.resolve({ agentId: agentKey }) },
  );
}

function form(file: File | null, threadId?: string) {
  const f = new FormData();
  if (file) f.append('file', file, file.name);
  if (threadId !== undefined) f.append('threadId', threadId);
  return f;
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
            if (key === AGENT.id || key === AGENT.urlKey) return AGENT;
            throw new ChatAgentError('Agent not found', 404);
          },
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
    const res = await upload('alice', form(new File([PNG], 'Screen Shot.png', { type: 'image/png' }), 'thread-1'));
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
    const badThread = await upload('alice', form(new File(['a'], 'a.txt'), '../../etc'));
    assert.equal(badThread.status, 400);
    assert.match((await badThread.json()).error, /threadId/);
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
});
