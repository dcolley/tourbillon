/**
 * CHAT-1 hardening: workspace file writes resolve real paths and never follow links
 * (saveWorkspaceUpload, writeWorkspaceText, createWorkspaceDirectory → ensureSafeWorkspaceDir /
 * writeWorkspaceFileSafe). Real files in a temp workspace root with planted links.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  WorkspacePathError,
  createWorkspaceDirectory,
  ensureCompanyWorkspace,
  ensureSafeWorkspaceDir,
  saveWorkspaceUpload,
  writeWorkspaceText,
} from '@tourbillon/shared/company-workspace';

let root: string;
let outside: string;
const prevRoot = process.env.COMPANY_WORKSPACE_ROOT;
const A = 'co-a';
const B = 'co-b';
const ws = (company: string, rel = '') => path.join(root, company, rel);

describe('CHAT-1 hardening: safe workspace writes', () => {
  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'ws-write-'));
    outside = await mkdtemp(path.join(tmpdir(), 'ws-outside-'));
    process.env.COMPANY_WORKSPACE_ROOT = root;
    await ensureCompanyWorkspace(A);
    await ensureCompanyWorkspace(B);
    // Planted links inside company A's workspace.
    await mkdir(ws(A, 'resources/chat-uploads'), { recursive: true });
    await symlink(ws(B, 'resources'), ws(A, 'resources/chat-uploads/bob')); // → other company
    await symlink(outside, ws(A, 'resources/escape')); // → outside the root
    await mkdir(ws(A, 'projects/real'), { recursive: true });
    await symlink(ws(A, 'projects/real'), ws(A, 'resources/alias')); // → inside A
    await symlink(path.join(outside, 'missing'), ws(A, 'resources/dangling'));
    await writeFile(path.join(outside, 'victim.txt'), 'original');
    await symlink(path.join(outside, 'victim.txt'), ws(A, 'resources/file-link.txt')); // file link
    await writeFile(ws(B, 'resources/secret.md'), 'B data');
    await link(ws(B, 'resources/secret.md'), ws(A, 'resources/hard.md')); // hard link to B's file
  });

  after(async () => {
    if (prevRoot === undefined) delete process.env.COMPANY_WORKSPACE_ROOT;
    else process.env.COMPANY_WORKSPACE_ROOT = prevRoot;
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it('writes normal paths, creating missing folders', async () => {
    const r = await saveWorkspaceUpload(A, 'resources/new/deep/a.txt', Buffer.from('hi'));
    assert.deepEqual(r, { path: 'resources/new/deep/a.txt', size: 2 });
    assert.equal(await readFile(ws(A, r.path), 'utf8'), 'hi');
    await writeWorkspaceText(A, 'resources/new/deep/a.txt', 'replaced');
    assert.equal(await readFile(ws(A, r.path), 'utf8'), 'replaced', 'non-exclusive writes replace');
  });

  it('exclusive uploads never replace an existing file', async () => {
    await saveWorkspaceUpload(A, 'resources/x/once.txt', Buffer.from('1'), { exclusive: true });
    await assert.rejects(
      saveWorkspaceUpload(A, 'resources/x/once.txt', Buffer.from('2'), { exclusive: true }),
      (e: unknown) => e instanceof WorkspacePathError && /already exists/.test(e.message),
    );
    assert.equal(await readFile(ws(A, 'resources/x/once.txt'), 'utf8'), '1');
  });

  it('refuses a directory link to another company workspace (no cross-company write)', async () => {
    const before = await readdir(ws(B, 'resources'));
    await assert.rejects(
      saveWorkspaceUpload(A, 'resources/chat-uploads/bob/t1/a.txt', Buffer.from('x')),
      (e: unknown) => e instanceof WorkspacePathError && /escapes/.test(e.message),
    );
    await assert.rejects(writeWorkspaceText(A, 'resources/chat-uploads/bob/notes.md', 'x'), WorkspacePathError);
    await assert.rejects(createWorkspaceDirectory(A, 'resources/chat-uploads/bob/newdir'), WorkspacePathError);
    assert.deepEqual(await readdir(ws(B, 'resources')), before);
  });

  it('refuses a directory link outside the workspace root, and a dangling link', async () => {
    await assert.rejects(saveWorkspaceUpload(A, 'resources/escape/a.txt', Buffer.from('x')), WorkspacePathError);
    await assert.rejects(saveWorkspaceUpload(A, 'resources/dangling/a.txt', Buffer.from('x')), WorkspacePathError);
    assert.deepEqual(await readdir(outside), ['victim.txt']);
  });

  it('allows a directory link that stays inside the same company workspace', async () => {
    await saveWorkspaceUpload(A, 'resources/alias/in.txt', Buffer.from('ok'));
    assert.equal(await readFile(ws(A, 'projects/real/in.txt'), 'utf8'), 'ok');
    assert.equal(await ensureSafeWorkspaceDir(A, 'resources/alias'), await realpath(ws(A, 'projects/real')));
  });

  it('refuses to write through a file link (upload and text write)', async () => {
    await assert.rejects(
      saveWorkspaceUpload(A, 'resources/file-link.txt', Buffer.from('pwned')),
      (e: unknown) => e instanceof WorkspacePathError && /symbolic link/.test(e.message),
    );
    await assert.rejects(writeWorkspaceText(A, 'resources/file-link.txt', 'pwned'), WorkspacePathError);
    assert.equal(await readFile(path.join(outside, 'victim.txt'), 'utf8'), 'original');
  });

  it('refuses to write to a hard-linked file (would change the other copy)', async () => {
    await assert.rejects(
      writeWorkspaceText(A, 'resources/hard.md', 'pwned'),
      (e: unknown) => e instanceof WorkspacePathError && /several links/.test(e.message),
    );
    assert.equal(await readFile(ws(B, 'resources/secret.md'), 'utf8'), 'B data');
  });

  it('refuses writing a file where a folder is', async () => {
    await assert.rejects(saveWorkspaceUpload(A, 'projects/real', Buffer.from('x')), WorkspacePathError);
    assert.equal((await stat(ws(A, 'projects/real'))).isDirectory(), true, 'still a folder');
  });
});
