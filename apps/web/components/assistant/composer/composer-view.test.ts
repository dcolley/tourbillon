/**
 * CHAT-1: composer view — server render (no DOM library in this repo) plus the element tree, whose
 * handlers are driven against a real controller: attach (picker / paste / drop), limits, chips,
 * queue edit / remove, Send vs Steer / Queue follow-up / Stop.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Composer, ComposerView, initialViewState } from './composer';
import { createComposerController, type ComposerRunStatus } from './composer-controller';
import { createDraftStore, draftKey, type DraftStorage } from './draft-store';

// tsx compiles .tsx with the classic JSX runtime; components/ui files rely on Next's automatic
// runtime and do not import React, so give them the global it expects.
(globalThis as { React?: typeof React }).React = React;

type El = ReactElement<Record<string, any>>;

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

function all(node: ReactNode, out: El[] = []): El[] {
  if (Array.isArray(node)) node.forEach((n) => all(n, out));
  else if (isValidElement(node)) {
    out.push(node as El);
    all((node as El).props.children, out);
  }
  return out;
}

const tick = () => new Promise<void>((r) => setImmediate(r));

function setup(runStatus: ComposerRunStatus = 'idle') {
  const calls: string[] = [];
  const storage = new MemoryStorage();
  const c = createComposerController({
    controls: {
      send: async (t) => {
        calls.push(`send:${t}`);
        return { ok: true };
      },
      steer: async (t) => {
        calls.push(`steer:${t}`);
        return { ok: true };
      },
      stop: () => calls.push('stop'),
    },
    upload: async (file) => ({ path: `resources/chat-uploads/alice/t1/u-${file.name}`, name: file.name, size: file.size, mediaType: 'text/plain' }),
    drafts: createDraftStore(storage),
    draftKey: draftKey('alice', 't1'),
    runStatus,
  });
  const tree = () => all(ComposerView({ state: c.getState(), controller: c }));
  const html = () => renderToStaticMarkup(createElement(ComposerView, { state: c.getState(), controller: c }));
  const byLabel = (label: string) => tree().find((e) => e.props['aria-label'] === label);
  const buttonText = (text: string) =>
    tree().find((e) => typeof e.props.onClick === 'function' && textOf(e).includes(text));
  return { c, calls, storage, tree, html, byLabel, buttonText };
}

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement(node)) return textOf((node as El).props.children);
  return '';
}

const pd = () => {};
const txt = (name: string) => new File(['hello'], name, { type: 'text/plain' });

describe('CHAT-1 composer view', () => {
  it('idle: multiline textarea, attach control, Send; no run controls', () => {
    const { html } = setup();
    const out = html();
    assert.match(out, /<textarea[^>]*aria-label="Message"/);
    assert.match(out, /Enter to send, Shift\+Enter for a new line/);
    assert.match(out, /type="file"[^>]*multiple/);
    assert.match(out, /accept="[^"]*\.png[^"]*"/);
    assert.match(out, />Send<\/button>|Send<\/button>/);
    assert.doesNotMatch(out, /Steer|Queue follow-up|Stop/);
  });

  it('typing then Enter sends via the controller; Send is disabled with nothing to send', async () => {
    const s = setup();
    const send = s.buttonText('Send')!;
    assert.equal(send.props.disabled, true);
    s.byLabel('Message')!.props.onChange({ target: { value: 'hello there' } });
    assert.equal(s.byLabel('Message')!.props.value, 'hello there');
    assert.equal(s.buttonText('Send')!.props.disabled, false);
    s.byLabel('Message')!.props.onKeyDown({ key: 'Enter', shiftKey: true, nativeEvent: {}, preventDefault: pd });
    assert.deepEqual(s.calls, []);
    s.byLabel('Message')!.props.onKeyDown({ key: 'Enter', nativeEvent: {}, preventDefault: pd });
    await tick();
    assert.deepEqual(s.calls, ['send:hello there']);
  });

  it('picker, paste and drop all add chips with Remove; refused files show an alert', async () => {
    const s = setup();
    const input = s.tree().find((e) => e.props['data-slot'] === 'composer-file-input')!;
    const target = { files: [txt('a.txt'), new File(['MZ'], 'x.exe')], value: 'C:\\fakepath\\a.txt' };
    input.props.onChange({ target });
    assert.equal(target.value, '', 'input reset so the same file can be picked again');
    s.byLabel('Message')!.props.onPaste({ clipboardData: { files: [txt('b.md')] }, preventDefault: pd });
    const root = s.tree()[0];
    root.props.onDragEnter({ dataTransfer: { types: ['Files'] }, preventDefault: pd });
    assert.match(s.html(), /data-slot="composer-dropzone"/);
    assert.match(s.html(), /Drop files to attach \(up to 10, 10 MB each\)/);
    s.tree()[0].props.onDrop({ dataTransfer: { files: [txt('c.csv')] }, preventDefault: pd });
    await tick();
    const out = s.html();
    assert.doesNotMatch(out, /composer-dropzone/);
    for (const name of ['a.txt', 'b.md', 'c.csv']) assert.match(out, new RegExp(`aria-label="Remove ${name.replace('.', '\\.')}"`));
    assert.match(out, /role="alert"[\s\S]*x\.exe: \.exe files can(&#x27;|')t be attached/);
    assert.match(out, /data-status="ready"/);

    s.byLabel('Remove b.md')!.props.onClick();
    assert.doesNotMatch(s.html(), /b\.md/);
    s.byLabel('Dismiss')!.props.onClick();
    assert.doesNotMatch(s.html(), /role="alert"/);
  });

  it('uploading chips show progress and block Send', () => {
    const c = createComposerController({
      controls: { send: async () => ({ ok: true }), steer: async () => ({ ok: true }), stop: () => {} },
      upload: () => new Promise(() => {}),
      drafts: createDraftStore(new MemoryStorage()),
    });
    c.setText('x');
    c.addFiles([txt('slow.txt')]);
    const out = renderToStaticMarkup(createElement(ComposerView, { state: c.getState(), controller: c }));
    assert.match(out, /data-status="uploading"/);
    assert.match(out, /aria-label="Uploading"/);
    const send = all(ComposerView({ state: c.getState(), controller: c })).find((e) => textOf(e).trim() === 'Send' && e.props.onClick);
    assert.equal(send?.props.disabled, true);
  });

  it('running: Steer, Queue follow-up and Stop; queued items have Edit and Remove', async () => {
    const s = setup('running');
    let out = s.html();
    assert.match(out, /Steer/);
    assert.match(out, /Queue follow-up/);
    assert.match(out, /Stop/);
    assert.match(out, /Enter queues, Ctrl\+Enter steers/);
    assert.doesNotMatch(out, />\s*Send\s*</);

    s.c.setText('next thing');
    s.buttonText('Queue follow-up')!.props.onClick();
    await tick();
    out = s.html();
    assert.match(out, /aria-label="Queued follow-ups"/);
    assert.match(out, /next thing/);

    s.byLabel('Edit queued message')!.props.onClick();
    const editor = s.tree().find((e) => e.props['aria-label'] === 'Edit queued message' && 'value' in e.props)!;
    editor.props.onChange({ target: { value: 'next thing, edited' } });
    s.buttonText('Save')!.props.onClick();
    assert.match(s.html(), /next thing, edited/);

    s.c.setText('steer me');
    s.buttonText('Steer')!.props.onClick();
    await tick();
    s.buttonText('Stop')!.props.onClick();
    assert.deepEqual(s.calls, ['steer:steer me', 'stop']);

    s.c.setRunStatus('idle');
    await tick();
    assert.deepEqual(s.calls.slice(2), ['send:next thing, edited']);
    assert.doesNotMatch(s.html(), /Queued follow-ups/);
  });

  it('remove a queued item', async () => {
    const s = setup('running');
    s.c.setText('drop me');
    await s.c.primary();
    s.byLabel('Remove queued message')!.props.onClick();
    assert.equal(s.c.getState().queue.length, 0);
  });

  it('stopping: Stop and Steer are disabled', () => {
    const s = setup('stopping');
    s.c.setText('x');
    assert.equal(s.buttonText('Stop')!.props.disabled, true);
    assert.equal(s.buttonText('Steer')!.props.disabled, true);
    assert.match(s.html(), /Stopping…/);
  });

  it('Composer renders on the server (no window): textarea and controls', () => {
    const out = renderToStaticMarkup(
      createElement(Composer, {
        agentId: 'alice',
        threadId: 't1',
        runStatus: 'idle',
        controls: { send: () => undefined, steer: () => undefined, stop: () => undefined },
        drafts: createDraftStore(new MemoryStorage()),
        upload: async () => {
          throw new Error('unused');
        },
      }),
    );
    assert.match(out, /data-slot="composer"/);
    assert.match(out, /aria-label="Message"/);
    assert.equal(initialViewState('running').runStatus, 'running');
  });

  it('Composer shows the saved draft for its thread', () => {
    const storage = new MemoryStorage();
    createDraftStore(storage).save(draftKey('alice', 't1'), { text: 'saved draft text', attachments: [] });
    const props = {
      agentId: 'alice',
      runStatus: 'idle' as const,
      controls: { send: () => undefined, steer: () => undefined, stop: () => undefined },
      drafts: createDraftStore(storage),
      upload: async () => {
        throw new Error('unused');
      },
    };
    assert.match(renderToStaticMarkup(createElement(Composer, { ...props, threadId: 't1' })), /saved draft text/);
    assert.doesNotMatch(renderToStaticMarkup(createElement(Composer, { ...props, threadId: 't2' })), /saved draft text/);
  });
});
