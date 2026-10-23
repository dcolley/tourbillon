/**
 * CHAT-1: composer behaviour — keys, attachments (picker / paste / drop, limits, uploads), run
 * controls (send, queue, steer, stop), queued follow-ups and drafts.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CHAT_ATTACHMENT_MAX_BYTES, CHAT_ATTACHMENT_MAX_FILES, type ChatAttachmentRef } from '@/lib/chat-attachments';
import {
  createComposerController,
  type ComposerControllerOptions,
  type ComposerControls,
  type ComposerSendResult,
  type KeyLike,
  type UploadAttachment,
} from './composer-controller';
import { createDraftStore, draftKey, type DraftStorage } from './draft-store';

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

const tick = () => new Promise<void>((r) => setImmediate(r));

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function controls(results: Array<ComposerSendResult | void> = []) {
  const calls: Array<{ op: 'send' | 'steer' | 'stop'; text?: string }> = [];
  const c: ComposerControls = {
    send: async (text) => {
      calls.push({ op: 'send', text });
      return results.length ? results.shift() : { ok: true };
    },
    steer: async (text) => {
      calls.push({ op: 'steer', text });
      return results.length ? results.shift() : { ok: true };
    },
    stop: () => {
      calls.push({ op: 'stop' });
    },
  };
  return { c, calls };
}

/** Upload stub: resolves immediately with a workspace ref unless told otherwise. */
function uploader(mode: 'ok' | 'fail' | 'manual' = 'ok') {
  const pending: Array<{ file: File; signal: AbortSignal; d: ReturnType<typeof deferred<ChatAttachmentRef>> }> = [];
  const fn: UploadAttachment = (file, { signal }) => {
    const ref = { path: `resources/chat-uploads/alice/t1/u-${file.name}`, name: file.name, size: file.size, mediaType: 'text/plain' };
    if (mode === 'ok') return Promise.resolve(ref);
    if (mode === 'fail') return Promise.reject(new Error('server said no'));
    const d = deferred<ChatAttachmentRef>();
    pending.push({ file, signal, d });
    return d.promise;
  };
  return { fn, pending };
}

function make(opts: Partial<ComposerControllerOptions> & { storage?: MemoryStorage } = {}) {
  const storage = opts.storage ?? new MemoryStorage();
  const ctl = controls();
  let n = 0;
  const c = createComposerController({
    controls: opts.controls ?? ctl.c,
    upload: opts.upload ?? uploader().fn,
    drafts: opts.drafts ?? createDraftStore(storage),
    draftKey: 'draftKey' in opts ? opts.draftKey : draftKey('alice', 't1'),
    runStatus: opts.runStatus,
    makeId: () => `id${++n}`,
  });
  return { c, calls: ctl.calls, storage };
}

function key(k: string, mods: Partial<KeyLike> = {}) {
  let prevented = false;
  const e: KeyLike = { key: k, ...mods, preventDefault: () => (prevented = true) };
  return { e, prevented: () => prevented };
}

const txt = (name: string, body = 'hello') => new File([body], name, { type: 'text/plain' });

describe('CHAT-1 composer keys', () => {
  it('Enter sends, Shift+Enter is a newline, IME composition is ignored', async () => {
    const { c, calls } = make();
    c.setText('line 1\nline 2');
    const shift = key('Enter', { shiftKey: true });
    assert.equal(c.handleKeyDown(shift.e), false);
    assert.equal(shift.prevented(), false, 'newline is left to the textarea');
    const ime = key('Enter', { nativeEvent: { isComposing: true } });
    assert.equal(c.handleKeyDown(ime.e), false);
    assert.equal(c.handleKeyDown(key('a').e), false);
    assert.equal(calls.length, 0);
    const enter = key('Enter');
    assert.equal(c.handleKeyDown(enter.e), true);
    assert.equal(enter.prevented(), true);
    await tick();
    assert.deepEqual(calls, [{ op: 'send', text: 'line 1\nline 2' }]);
    assert.equal(c.getState().text, '');
  });

  it('does not send whitespace only', async () => {
    const { c, calls } = make();
    c.setText('   \n ');
    c.handleKeyDown(key('Enter').e);
    await tick();
    assert.equal(calls.length, 0);
  });

  it('Ctrl/Cmd+Enter steers while a run is open, sends when idle', async () => {
    const { c, calls } = make();
    c.setText('first');
    c.handleKeyDown(key('Enter', { ctrlKey: true }).e);
    await tick();
    assert.deepEqual(calls, [{ op: 'send', text: 'first' }]);
    c.setRunStatus('running');
    c.setText('go left');
    c.handleKeyDown(key('Enter', { metaKey: true }).e);
    await tick();
    assert.deepEqual(calls[1], { op: 'steer', text: 'go left' });
  });
});

describe('CHAT-1 composer attachments', () => {
  it('picker: uploads accepted files as chips; sends their workspace paths with the text', async () => {
    const { c, calls } = make();
    assert.equal(c.addFiles([txt('a.txt'), txt('b.md')], 'picker'), 2);
    assert.deepEqual(c.getState().attachments.map((a) => a.status), ['uploading', 'uploading']);
    await tick();
    assert.deepEqual(c.getState().attachments.map((a) => [a.name, a.status]), [['a.txt', 'ready'], ['b.md', 'ready']]);
    c.setText('read these');
    await c.primary();
    assert.equal(calls.length, 1);
    assert.match(calls[0].text!, /^read these\n\n\[Attached files, saved in the company workspace\]\n- resources\/chat-uploads\/alice\/t1\/u-a\.txt \(a\.txt/);
    assert.match(calls[0].text!, /u-b\.md/);
    assert.equal(c.getState().attachments.length, 0);
  });

  it('refuses blocked types, unsupported types, oversize and empty files with clear notices', () => {
    const { c } = make();
    const big = new File([new Uint8Array(CHAT_ATTACHMENT_MAX_BYTES + 1)], 'huge.pdf');
    const n = c.addFiles([new File(['MZ'], 'tool.exe'), new File(['x'], 'a.zip'), big, new File([], 'empty.txt'), txt('ok.txt')]);
    assert.equal(n, 1);
    const messages = c.getState().notices.map((x) => x.message);
    assert.equal(messages.length, 4);
    assert.match(messages[0], /tool\.exe: \.exe files can't be attached/);
    assert.match(messages[1], /a\.zip: \.zip files aren't supported/);
    assert.equal(messages[2], 'huge.pdf: 10,485,761 bytes is over the 10 MB limit (10,485,760 bytes).');
    assert.match(messages[3], /empty\.txt: the file is empty/);
    assert.deepEqual(c.getState().attachments.map((a) => a.name), ['ok.txt']);
    c.dismissNotice(0);
    assert.equal(c.getState().notices.length, 3);
  });

  it(`limits a message to ${CHAT_ATTACHMENT_MAX_FILES} files`, () => {
    const { c } = make({ upload: uploader('manual').fn });
    const files = Array.from({ length: CHAT_ATTACHMENT_MAX_FILES + 2 }, (_, i) => txt(`f${i}.txt`));
    assert.equal(c.addFiles(files), CHAT_ATTACHMENT_MAX_FILES);
    assert.equal(c.getState().attachments.length, CHAT_ATTACHMENT_MAX_FILES);
    assert.equal(c.getState().notices.length, 2);
    assert.match(c.getState().notices[0].message, /at most 10 files per message/);
  });

  it('paste: clipboard files become attachments (screenshots get a name); plain text paste is untouched', async () => {
    const { c } = make();
    let prevented = false;
    const png = new File([new Uint8Array([0x89, 0x50])], 'image.png', { type: 'image/png' });
    assert.equal(c.handlePaste({ clipboardData: { files: [png] }, preventDefault: () => (prevented = true) }), true);
    assert.equal(prevented, true);
    assert.equal(c.getState().attachments[0].name, 'pasted-image-1.png');
    prevented = false;
    assert.equal(c.handlePaste({ clipboardData: { files: [] }, preventDefault: () => (prevented = true) }), false);
    assert.equal(c.handlePaste({ clipboardData: null, preventDefault: () => (prevented = true) }), false);
    assert.equal(prevented, false);
  });

  it('drag and drop: shows the drop zone for file drags and attaches dropped files', () => {
    const { c } = make();
    const pd = () => {};
    c.handleDragEnter({ dataTransfer: { types: ['text/plain'] }, preventDefault: pd });
    assert.equal(c.getState().dragging, false, 'text drags are not file drops');
    c.handleDragEnter({ dataTransfer: { types: ['Files'] }, preventDefault: pd });
    c.handleDragEnter({ dataTransfer: { types: ['Files'] }, preventDefault: pd }); // child element
    c.handleDragLeave();
    assert.equal(c.getState().dragging, true, 'still over the composer');
    let prevented = false;
    const n = c.handleDrop({ dataTransfer: { files: [txt('d.csv', 'a,b'), new File(['x'], 'evil.bat')] }, preventDefault: () => (prevented = true) });
    assert.equal(prevented, true);
    assert.equal(n, 1);
    assert.equal(c.getState().dragging, false);
    assert.deepEqual(c.getState().attachments.map((a) => a.name), ['d.csv']);
    assert.match(c.getState().notices[0].message, /evil\.bat/);
  });

  it('remove: drops the chip and aborts its upload; sending waits for uploads', async () => {
    const up = uploader('manual');
    const { c, calls } = make({ upload: up.fn });
    c.addFiles([txt('a.txt'), txt('b.txt')]);
    c.setText('hi');
    assert.equal(c.canSubmit(), false, 'upload in flight');
    assert.equal(await c.primary(), false);
    assert.equal(calls.length, 0);
    const [a, b] = c.getState().attachments;
    c.removeAttachment(a.id);
    assert.equal(up.pending[0].signal.aborted, true);
    up.pending[0].d.resolve({ path: 'x', name: 'a.txt', size: 5, mediaType: 'text/plain' });
    up.pending[1].d.resolve({ path: 'resources/chat-uploads/alice/t1/b.txt', name: 'b.txt', size: 5, mediaType: 'text/plain' });
    await tick();
    assert.deepEqual(c.getState().attachments.map((x) => [x.id, x.status]), [[b.id, 'ready']]);
    assert.equal(c.canSubmit(), true);
    await c.primary();
    assert.equal(calls.length, 1);
    assert.ok(!calls[0].text!.includes('a.txt'));
  });

  it('a failed upload removes the chip with a notice', async () => {
    const { c } = make({ upload: uploader('fail').fn });
    c.addFiles([txt('a.txt')]);
    await tick();
    assert.equal(c.getState().attachments.length, 0);
    assert.match(c.getState().notices[0].message, /a\.txt: upload failed — server said no/);
  });

  it('cancelUploads aborts in-flight uploads (unmount)', () => {
    const up = uploader('manual');
    const { c } = make({ upload: up.fn });
    c.addFiles([txt('a.txt')]);
    c.cancelUploads();
    assert.equal(up.pending[0].signal.aborted, true);
    assert.equal(c.getState().attachments.length, 0);
  });
});

describe('CHAT-1 composer run controls', () => {
  it('while a run is open: the primary action queues, Steer reaches the agent, Stop ends the run', async () => {
    const { c, calls } = make({ runStatus: 'running' });
    c.setText('then do B');
    assert.equal(await c.primary(), true);
    assert.equal(calls.length, 0, 'queued, not sent');
    assert.deepEqual(c.getState().queue.map((q) => q.text), ['then do B']);
    assert.equal(c.getState().text, '');

    c.setText('focus on tests');
    assert.equal(await c.steer(), true);
    assert.deepEqual(calls, [{ op: 'steer', text: 'focus on tests' }]);

    c.stop();
    assert.deepEqual(calls[1], { op: 'stop' });
    c.setRunStatus('stopping');
    c.stop();
    assert.equal(await c.steer(), false);
    assert.equal(calls.length, 2, 'no second stop, no steer while stopping');
  });

  it('steer and stop do nothing when idle', async () => {
    const { c, calls } = make();
    c.setText('x');
    assert.equal(await c.steer(), false);
    c.stop();
    assert.equal(calls.length, 0);
    assert.equal(c.getState().text, 'x');
  });

  it('queued follow-ups send one per run, in order, after each run ends', async () => {
    const { c, calls } = make({ runStatus: 'running' });
    for (const t of ['one', 'two']) {
      c.setText(t);
      await c.primary();
    }
    c.setRunStatus('idle');
    await tick();
    assert.deepEqual(calls, [{ op: 'send', text: 'one' }]);
    assert.deepEqual(c.getState().queue.map((q) => q.text), ['two']);
    c.setRunStatus('starting');
    c.setRunStatus('running');
    await tick();
    assert.equal(calls.length, 1);
    c.setRunStatus('idle');
    await tick();
    assert.deepEqual(calls[1], { op: 'send', text: 'two' });
    assert.equal(c.getState().queue.length, 0);
  });

  it('queued items are editable and removable until sent', async () => {
    const { c, calls } = make({ runStatus: 'running' });
    for (const t of ['a', 'b', 'c']) {
      c.setText(t);
      await c.primary();
    }
    const [a, b, cc] = c.getState().queue;
    c.startEdit(b.id);
    assert.deepEqual(c.getState().editing, { id: b.id, text: 'b' });
    c.setEditText('b edited');
    c.saveEdit();
    assert.equal(c.getState().editing, null);
    c.startEdit(cc.id);
    c.setEditText('discard me');
    c.cancelEdit();
    c.removeQueued(a.id);
    assert.deepEqual(c.getState().queue.map((q) => q.text), ['b edited', 'c']);
    c.setRunStatus('idle');
    await tick();
    assert.deepEqual(calls, [{ op: 'send', text: 'b edited' }]);
  });

  it('a queued item that fails to send goes back to the front of the queue; Send next retries', async () => {
    const ctl = controls([{ ok: false, error: 'busy' }]);
    const { c } = make({ controls: ctl.c, runStatus: 'running' });
    c.setText('later');
    await c.primary();
    c.setRunStatus('idle');
    await tick();
    assert.deepEqual(c.getState().queue.map((q) => q.text), ['later']);
    assert.match(c.getState().notices[0].message, /Queued message not sent: busy/);
    await c.sendNextQueued();
    assert.equal(c.getState().queue.length, 0);
    assert.deepEqual(ctl.calls.map((x) => x.text), ['later', 'later']);
  });

  it('a refused send keeps the text and attachments', async () => {
    const ctl = controls([{ ok: false }]);
    const { c } = make({ controls: ctl.c });
    c.addFiles([txt('a.txt')]);
    await tick();
    c.setText('important');
    assert.equal(await c.primary(), false);
    assert.equal(c.getState().text, 'important');
    assert.equal(c.getState().attachments.length, 1);
    assert.match(c.getState().notices[0].message, /still here/);
  });

  it('a send that throws is reported and keeps the text', async () => {
    const c = createComposerController({
      controls: {
        send: async () => {
          throw new Error('network down');
        },
        steer: async () => ({ ok: true }),
        stop: () => {},
      },
      upload: uploader().fn,
      drafts: createDraftStore(new MemoryStorage()),
    });
    c.setText('hi');
    await c.primary();
    assert.equal(c.getState().text, 'hi');
    assert.match(c.getState().notices[0].message, /network down/);
  });

  it('no double send while a send is in flight', async () => {
    const d = deferred<{ ok: boolean }>();
    let sends = 0;
    const c = createComposerController({
      controls: { send: () => (sends++, d.promise), steer: async () => ({ ok: true }), stop: () => {} },
      upload: uploader().fn,
      drafts: createDraftStore(new MemoryStorage()),
    });
    c.setText('once');
    const p = c.primary();
    c.setText('typed meanwhile');
    assert.equal(c.getState().submitting, true);
    assert.equal(await c.primary(), false);
    d.resolve({ ok: true });
    await p;
    assert.equal(sends, 1);
    assert.equal(c.getState().text, 'typed meanwhile');
  });

  it('setControls swaps the chat client used by later actions', async () => {
    const { c, calls } = make();
    const next = controls();
    c.setControls(next.c);
    c.setText('to the new client');
    await c.primary();
    assert.equal(calls.length, 0);
    assert.deepEqual(next.calls, [{ op: 'send', text: 'to the new client' }]);
  });

  it('subscribers are notified of changes', () => {
    const { c } = make();
    let n = 0;
    const off = c.subscribe(() => n++);
    c.setText('a');
    c.setText('ab');
    off();
    c.setText('abc');
    assert.equal(n, 2);
  });
});

describe('CHAT-1 composer drafts', () => {
  it('the draft (text and ready attachments) survives a reload, per thread', async () => {
    const storage = new MemoryStorage();
    const first = make({ storage });
    first.c.setText('half-written\nthought');
    first.c.addFiles([txt('a.txt')]);
    await tick();
    // "Reload": a fresh controller over the same storage.
    const again = make({ storage });
    assert.equal(again.c.getState().text, 'half-written\nthought');
    assert.deepEqual(again.c.getState().attachments.map((a) => [a.name, a.status]), [['a.txt', 'ready']]);
    const other = make({ storage, draftKey: draftKey('alice', 't2') });
    assert.equal(other.c.getState().text, '');
  });

  it('uploading chips are not saved; the draft is cleared after a send', async () => {
    const storage = new MemoryStorage();
    const up = uploader('manual');
    const first = make({ storage, upload: up.fn });
    first.c.setText('x');
    first.c.addFiles([txt('a.txt')]);
    assert.equal(make({ storage }).c.getState().attachments.length, 0);
    up.pending[0].d.resolve({ path: 'p/a.txt', name: 'a.txt', size: 5, mediaType: 'text/plain' });
    await tick();
    await first.c.primary();
    assert.equal(storage.length, 0);
    assert.equal(make({ storage }).c.getState().text, '');
  });

  it('a queued message clears the draft', async () => {
    const storage = new MemoryStorage();
    const { c } = make({ storage, runStatus: 'running' });
    c.setText('queued');
    await c.primary();
    assert.equal(storage.length, 0);
  });

  it('no draft key → nothing saved', () => {
    const storage = new MemoryStorage();
    const { c } = make({ storage, draftKey: undefined });
    c.setText('x');
    assert.equal(storage.length, 0);
  });
});
