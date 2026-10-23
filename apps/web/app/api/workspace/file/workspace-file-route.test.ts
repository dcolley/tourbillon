/**
 * CHAT-1 hardening: /api/workspace/file uploads and text writes stay inside the active company's
 * workspace (no writes through planted links) and uploads are size-capped while streaming.
 * '@/lib/company' is mocked (active company); the workspace is real, in a temp directory.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

type Handler = (req: NextRequest) => Promise<Response>;

let POST: Handler;
let PUT: Handler;
let root: string;
let outside: string;
let companyCalls = 0;
const prevRoot = process.env.COMPANY_WORKSPACE_ROOT;
const ws = (rel = '') => path.join(root, 'company-a', rel);

function post(body: FormData | ReadableStream<Uint8Array>, headers: Record<string, string> = {}) {
  return POST(
    new NextRequest('http://localhost/api/workspace/file', {
      method: 'POST',
      body,
      headers,
      duplex: 'half',
    } as ConstructorParameters<typeof NextRequest>[1] & { duplex: 'half' }),
  );
}

function put(json: unknown) {
  return PUT(
    new NextRequest('http://localhost/api/workspace/file', {
      method: 'PUT',
      body: JSON.stringify(json),
      headers: { 'content-type': 'application/json' },
    }),
  );
}

function uploadForm(name: string, content: string, targetDir?: string) {
  const f = new FormData();
  f.append('file', new File([content], name), name);
  if (targetDir !== undefined) f.append('targetDir', targetDir);
  return f;
}

describe('CHAT-1 hardening /api/workspace/file writes', () => {
  let originalRequire: any;

  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'wsfile-'));
    outside = await mkdtemp(path.join(tmpdir(), 'wsfile-out-'));
    process.env.COMPANY_WORKSPACE_ROOT = root;
    const Module = require('module');
    originalRequire = Module.prototype.require;
    Module.prototype.require = function (id: string) {
      if (id === '@/lib/company' || id.endsWith('/lib/company')) {
        return {
          getActiveCompany: async () => {
            companyCalls += 1;
            return { id: 'company-a', name: 'A' };
          },
        };
      }
      return originalRequire.apply(this, arguments as unknown as [string]);
    };
    const mod = await import('./route');
    POST = mod.POST as unknown as Handler;
    PUT = mod.PUT as unknown as Handler;
    Module.prototype.require = originalRequire;

    await mkdir(ws('resources'), { recursive: true });
    await mkdir(path.join(root, 'company-b', 'resources'), { recursive: true });
    await writeFile(path.join(root, 'company-b', 'resources', 'keep.md'), 'B');
    await symlink(path.join(root, 'company-b', 'resources'), ws('resources/bob'));
    await symlink(outside, ws('resources/out'));
    await writeFile(path.join(outside, 'victim.md'), 'original');
    await symlink(path.join(outside, 'victim.md'), ws('resources/link.md'));
  });

  after(async () => {
    require('module').prototype.require = originalRequire;
    if (prevRoot === undefined) delete process.env.COMPANY_WORKSPACE_ROOT;
    else process.env.COMPANY_WORKSPACE_ROOT = prevRoot;
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it('uploads and writes normal paths', async () => {
    const res = await post(uploadForm('a.md', 'hello', 'resources/notes'));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { path: 'resources/notes/a.md', size: 5 });
    assert.equal(await readFile(ws('resources/notes/a.md'), 'utf8'), 'hello');
    assert.equal((await put({ path: 'resources/notes/a.md', content: 'edited' })).status, 200);
    assert.equal(await readFile(ws('resources/notes/a.md'), 'utf8'), 'edited');
  });

  it('refuses uploads through a folder link to another company or outside the root', async () => {
    for (const targetDir of ['resources/bob', 'resources/bob/deeper', 'resources/out']) {
      const res = await post(uploadForm('x.md', 'x', targetDir));
      assert.equal(res.status, 400, targetDir);
      assert.match((await res.json()).error, /escapes/);
    }
    assert.deepEqual(await readdir(path.join(root, 'company-b', 'resources')), ['keep.md']);
    assert.deepEqual(await readdir(outside), ['victim.md']);
  });

  it('refuses text writes through folder and file links', async () => {
    assert.equal((await put({ path: 'resources/bob/keep.md', content: 'pwned' })).status, 400);
    assert.equal((await put({ path: 'resources/link.md', content: 'pwned' })).status, 400);
    assert.equal((await post(uploadForm('link.md', 'pwned', 'resources'))).status, 400);
    assert.equal(await readFile(path.join(root, 'company-b', 'resources', 'keep.md'), 'utf8'), 'B');
    assert.equal(await readFile(path.join(outside, 'victim.md'), 'utf8'), 'original');
  });

  it('a large upload without Content-Length is aborted soon after the limit (413)', async () => {
    const MB = 1024 * 1024;
    const head = new TextEncoder().encode(
      '--XB\r\nContent-Disposition: form-data; name="file"; filename="big.md"\r\nContent-Type: text/plain\r\n\r\n',
    );
    const stats = { pulled: 0, cancelled: false };
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (stats.pulled === 0) {
            stats.pulled += head.length;
            return controller.enqueue(head);
          }
          if (stats.pulled >= 512 * MB) return controller.close();
          stats.pulled += MB;
          controller.enqueue(new Uint8Array(MB).fill(0x61));
        },
        cancel() {
          stats.cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const before = companyCalls;
    const res = await post(stream, { 'content-type': 'multipart/form-data; boundary=XB' });
    assert.equal(res.status, 413);
    assert.equal(companyCalls, before + 1, 'active company checked first');
    assert.ok(stats.pulled < 13 * MB, `pulled ${stats.pulled} bytes`);
    assert.equal(stats.cancelled, true);
  });

  it('a declared Content-Length over the limit is refused (413)', async () => {
    const res = await post(uploadForm('a.md', 'x'), { 'content-length': String(64 * 1024 * 1024) });
    assert.equal(res.status, 413);
  });
});
