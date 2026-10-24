/**
 * CHAT-1 integration: composer controller + the real attachment upload route + a stub AG-UI chat
 * client with the AGUI-1b client's control surface (send / steer / stop, run status
 * idle → starting → running → stopping → idle, AG-UI run events).
 *
 * Covers the story's acceptance: a file is uploaded to the workspace and its path reaches the agent;
 * refused files never hit the server; Stop ends the run; a queued message is sent after the run
 * ends; steer reaches the running agent; the draft survives a reload.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { createComposerController, type ComposerRunStatus } from '@/components/assistant/composer/composer-controller';
import { createDraftStore, draftKey, type DraftStorage } from '@/components/assistant/composer/draft-store';
import { attachmentUploadUrl, createAttachmentUploader } from '@/components/assistant/composer/upload';

type Handler = (req: NextRequest, ctx: { params: Promise<{ agentId: string }> }) => Promise<Response>;
const AGENT = { id: 'agent-a', urlKey: 'alice', name: 'Alice', companyId: 'company-a', modelId: 'm' };

class ChatAgentError extends Error {
  constructor(message: string, readonly status = 404) {
    super(message);
  }
}
class ActiveCompanyError extends Error {}

class MemoryStorage implements DraftStorage {
  map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}

type AguiEvent = { type: string; runId: string; [k: string]: unknown };

/** Stub AG-UI chat client: one run at a time; the "agent" sees the user message and any steers. */
class StubAguiClient {
  status: ComposerRunStatus = 'idle';
  events: AguiEvent[] = [];
  runs: Array<{ runId: string; input: string; steers: string[]; outcome?: 'finished' | 'aborted' }> = [];
  private listeners = new Set<(s: ComposerRunStatus) => void>();
  private n = 0;

  onStatus(fn: (s: ComposerRunStatus) => void) {
    this.listeners.add(fn);
  }
  private setStatus(s: ComposerRunStatus) {
    this.status = s;
    for (const l of this.listeners) l(s);
  }
  private get current() {
    return this.runs[this.runs.length - 1];
  }
  async send(text: string) {
    if (this.status !== 'idle') return { ok: false, error: 'a run is already open' };
    const runId = `run-${++this.n}`;
    this.runs.push({ runId, input: text, steers: [] });
    this.setStatus('starting');
    await Promise.resolve();
    this.events.push({ type: 'RUN_STARTED', runId });
    this.setStatus('running');
    return { ok: true };
  }
  async steer(text: string) {
    if (this.status !== 'running') return { ok: false, error: 'no running agent' };
    this.current.steers.push(text);
    this.events.push({ type: 'CUSTOM', name: 'steer', runId: this.current.runId, value: text });
    return { ok: true };
  }
  stop() {
    if (this.status !== 'running' && this.status !== 'starting') return;
    this.setStatus('stopping');
    queueMicrotask(() => {
      this.current.outcome = 'aborted';
      this.events.push({ type: 'RUN_ERROR', runId: this.current.runId, message: 'aborted' });
      this.setStatus('idle');
    });
  }
  /** The agent finishes its turn. */
  finish(reply = 'done') {
    this.events.push({ type: 'TEXT_MESSAGE_CONTENT', runId: this.current.runId, delta: reply });
    this.events.push({ type: 'RUN_FINISHED', runId: this.current.runId });
    this.current.outcome = 'finished';
    this.setStatus('idle');
  }
}

const tick = () => new Promise<void>((r) => setImmediate(r));
async function settle() {
  for (let i = 0; i < 5; i++) await tick();
}
/** Waits for real I/O (the upload route writes to disk). */
async function waitFor(cond: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}
const noUploads = (c: { getState(): { attachments: Array<{ status: string }> } }) => () =>
  c.getState().attachments.every((a) => a.status !== 'uploading');

let POST: Handler;
let root: string;
const prevRoot = process.env.COMPANY_WORKSPACE_ROOT;
let uploadRequests = 0;

/** fetch → the route handler (what the browser would hit). */
const routeFetch: typeof fetch = async (input, init) => {
  const url = String(input);
  assert.equal(url, attachmentUploadUrl('alice', 'thread-1'));
  assert.equal(url, '/api/agui/alice/attachments?threadId=thread-1');
  uploadRequests++;
  const req = new NextRequest(`http://localhost${url}`, init as ConstructorParameters<typeof NextRequest>[1]);
  return POST(req, { params: Promise.resolve({ agentId: 'alice' }) });
};

function wire(storage: MemoryStorage, client: StubAguiClient) {
  const c = createComposerController({
    controls: { send: (t) => client.send(t), steer: (t) => client.steer(t), stop: () => client.stop() },
    upload: createAttachmentUploader('alice', 'thread-1', routeFetch),
    drafts: createDraftStore(storage),
    draftKey: draftKey('alice', 'thread-1'),
    runStatus: client.status,
  });
  client.onStatus((s) => c.setRunStatus(s));
  return c;
}

describe('CHAT-1 composer ↔ upload route ↔ stub AG-UI client', () => {
  let originalRequire: any;

  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'chat1-int-'));
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
            if (key === AGENT.id || key === AGENT.urlKey) return AGENT;
            throw new ChatAgentError('Agent not found', 404);
          },
          getOrCreateChatController: async () => ({
            queryThreadById: async ({ threadId }: { threadId: string }) =>
              threadId === 'thread-1'
                ? { resourceId: `company-${AGENT.companyId}:chat:user-1`, metadata: { agentId: AGENT.id } }
                : null,
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
    uploadRequests = 0;
  });

  it('an attached file is stored in the workspace and its path reaches the agent', async () => {
    const client = new StubAguiClient();
    const c = wire(new MemoryStorage(), client);
    c.addFiles([new File(['a,b\n1,2\n'], 'data.csv', { type: 'text/csv' })], 'drop');
    await waitFor(noUploads(c));
    const chip = c.getState().attachments[0];
    assert.equal(chip.status, 'ready');
    const ref = chip.status === 'ready' ? chip.ref : null;
    assert.match(ref!.path, /^resources\/chat-uploads\/alice\/thread-1\/.+-data\.csv$/);
    assert.equal(await readFile(path.join(root, AGENT.companyId, ref!.path), 'utf8'), 'a,b\n1,2\n');

    c.setText('Chart this');
    assert.equal(await c.primary(), true);
    assert.equal(client.runs.length, 1);
    assert.ok(client.runs[0].input.startsWith('Chart this\n\n[Attached files'));
    assert.ok(client.runs[0].input.includes(ref!.path));
    assert.equal(c.getState().runStatus, 'running');
  });

  it('refused files never reach the server; a server refusal shows its message', async () => {
    const client = new StubAguiClient();
    const c = wire(new MemoryStorage(), client);
    c.addFiles([new File(['MZ'], 'setup.exe'), new File([new Uint8Array(11 * 1024 * 1024)], 'big.txt')], 'picker');
    await settle();
    assert.equal(uploadRequests, 0);
    assert.equal(c.getState().notices.length, 2);
    // Passes the client checks, refused by the server's content check.
    c.addFiles([new File([new Uint8Array([0x4d, 0x5a, 0, 0])], 'fake.png', { type: 'image/png' })], 'paste');
    await waitFor(noUploads(c));
    assert.equal(uploadRequests, 1);
    assert.equal(c.getState().attachments.length, 0);
    assert.match(c.getState().notices[2].message, /fake\.png: upload failed — fake\.png: the content does not match a \.png file/);
  });

  it('steer reaches the running agent; a queued message is sent after the run finishes', async () => {
    const client = new StubAguiClient();
    const c = wire(new MemoryStorage(), client);
    c.setText('Start the report');
    await c.primary();
    assert.equal(c.getState().runStatus, 'running');

    c.setText('Use last quarter only');
    assert.equal(await c.steer(), true);
    assert.deepEqual(client.runs[0].steers, ['Use last quarter only']);
    assert.ok(client.events.some((e) => e.type === 'CUSTOM' && e.value === 'Use last quarter only'));

    c.setText('Then email it to me');
    await c.primary();
    assert.equal(client.runs.length, 1, 'queued, not sent mid-run');

    client.finish();
    await settle();
    assert.equal(client.runs.length, 2);
    assert.equal(client.runs[1].input, 'Then email it to me');
    assert.equal(c.getState().queue.length, 0);
    assert.equal(c.getState().runStatus, 'running');
  });

  it('Stop ends the run, then the queued follow-up is sent', async () => {
    const client = new StubAguiClient();
    const c = wire(new MemoryStorage(), client);
    c.setText('Long task');
    await c.primary();
    c.setText('After that, summarise');
    await c.primary();
    c.stop();
    assert.equal(c.getState().runStatus, 'stopping');
    await settle();
    assert.equal(client.runs[0].outcome, 'aborted');
    assert.ok(client.events.some((e) => e.type === 'RUN_ERROR' && e.runId === 'run-1'));
    assert.equal(client.runs[1]?.input, 'After that, summarise');
  });

  it('the draft (text and uploaded file) survives a reload', async () => {
    const storage = new MemoryStorage();
    const first = wire(storage, new StubAguiClient());
    first.setText('Draft in progress');
    first.addFiles([new File(['# notes'], 'notes.md')]);
    await waitFor(noUploads(first));
    const reloaded = wire(storage, new StubAguiClient());
    assert.equal(reloaded.getState().text, 'Draft in progress');
    assert.deepEqual(reloaded.getState().attachments.map((a) => [a.name, a.status]), [['notes.md', 'ready']]);
    const client = new StubAguiClient();
    const again = wire(storage, client);
    await again.primary();
    assert.match(client.runs[0].input, /notes\.md/);
    assert.equal(storage.length, 0, 'sent → draft cleared');
  });
});
