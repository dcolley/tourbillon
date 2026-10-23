/** CHAT-1: composer drafts per thread in localStorage. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DRAFT_KEY_PREFIX, MAX_DRAFTS, MAX_DRAFT_CHARS, createDraftStore, draftKey, type DraftStorage } from './draft-store';

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

const ref = { path: 'resources/chat-uploads/alice/t1/x-a.pdf', name: 'a.pdf', size: 10, mediaType: 'application/pdf' };

describe('CHAT-1 draft store', () => {
  it('keys drafts by agent and thread', () => {
    assert.equal(draftKey('alice', 't1'), `${DRAFT_KEY_PREFIX}alice:t1`);
    assert.equal(draftKey('alice'), `${DRAFT_KEY_PREFIX}alice:new`);
    assert.equal(draftKey('alice', null), `${DRAFT_KEY_PREFIX}alice:new`);
  });

  it('saves and loads text and attachments; a new store over the same storage sees it (reload)', () => {
    const storage = new MemoryStorage();
    createDraftStore(storage, () => 42).save(draftKey('alice', 't1'), { text: 'hello\nworld', attachments: [ref] });
    const reloaded = createDraftStore(storage);
    assert.deepEqual(reloaded.load(draftKey('alice', 't1')), { text: 'hello\nworld', attachments: [ref], updatedAt: 42 });
    assert.equal(reloaded.load(draftKey('alice', 't2')), null);
  });

  it('removes the entry when the draft is empty, and on clear', () => {
    const storage = new MemoryStorage();
    const store = createDraftStore(storage);
    const key = draftKey('a', 't');
    store.save(key, { text: 'x', attachments: [] });
    store.save(key, { text: '   ', attachments: [] });
    assert.equal(storage.length, 0);
    store.save(key, { text: '', attachments: [ref] });
    assert.equal(storage.length, 1);
    store.clear(key);
    assert.equal(storage.length, 0);
  });

  it('ignores corrupt or foreign values and bad attachment entries', () => {
    const storage = new MemoryStorage();
    const store = createDraftStore(storage);
    storage.setItem(draftKey('a', '1'), '{nope');
    storage.setItem(draftKey('a', '2'), JSON.stringify({ v: 2, text: 'x' }));
    storage.setItem(draftKey('a', '3'), JSON.stringify({ v: 1, text: 'ok', attachments: [ref, { path: 1 }, null] }));
    assert.equal(store.load(draftKey('a', '1')), null);
    assert.equal(store.load(draftKey('a', '2')), null);
    assert.deepEqual(store.load(draftKey('a', '3'))?.attachments, [ref]);
  });

  it('caps text length and the number of drafts (oldest dropped)', () => {
    const storage = new MemoryStorage();
    let t = 0;
    const store = createDraftStore(storage, () => ++t);
    store.save(draftKey('a', 'long'), { text: 'x'.repeat(MAX_DRAFT_CHARS + 10), attachments: [] });
    assert.equal(store.load(draftKey('a', 'long'))?.text.length, MAX_DRAFT_CHARS);
    storage.setItem('unrelated', 'keep');
    for (let i = 0; i < MAX_DRAFTS + 5; i++) store.save(draftKey('a', `t${i}`), { text: `d${i}`, attachments: [] });
    const keys = [...storage.map.keys()].filter((k) => k.startsWith(DRAFT_KEY_PREFIX));
    assert.equal(keys.length, MAX_DRAFTS);
    assert.ok(!keys.includes(draftKey('a', 'long')), 'oldest draft dropped');
    assert.ok(keys.includes(draftKey('a', `t${MAX_DRAFTS + 4}`)));
    assert.equal(storage.getItem('unrelated'), 'keep');
  });

  it('never throws when storage fails or is missing', () => {
    const broken: DraftStorage = {
      length: 0,
      key: () => null,
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    const store = createDraftStore(broken);
    assert.equal(store.load('k'), null);
    store.save('k', { text: 'x', attachments: [] });
    store.clear('k');
    const none = createDraftStore(null);
    none.save('k', { text: 'x', attachments: [] });
    assert.equal(none.load('k'), null);
  });
});
