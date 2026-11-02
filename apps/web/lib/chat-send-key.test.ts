/**
 * CHAT-SEND-KEY: the shared send-key helper and its stored preference.
 *
 * The gesture matrix is the acceptance contract for both modes: the wrong combo must never send
 * (Enter in `mod_enter_sends`, any modified Enter in `enter_sends`, anything while composing).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHAT_SEND_KEY_MODE_DESCRIPTIONS,
  CHAT_SEND_KEY_MODE_LABELS,
  CHAT_SEND_KEY_MODES,
  CHAT_SEND_KEY_SETTINGS_LABEL,
  CHAT_SEND_KEY_STORAGE_KEY,
  DEFAULT_CHAT_SEND_KEY_MODE,
  chatSendKeyHint,
  chatSendKeyModeOrDefault,
  isChatSendKeyMode,
  readChatSendKeyMode,
  resolveSendKeyGesture,
  subscribeChatSendKeyMode,
  writeChatSendKeyMode,
  type ChatSendKeyMode,
  type SendKeyEventLike,
} from './chat-send-key';

const enter = (over: Partial<SendKeyEventLike> = {}): SendKeyEventLike => ({ key: 'Enter', ...over });

type StorageEventHandler = (event: { key: string | null }) => void;

interface FakeWindow {
  localStorage: { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };
  addEventListener(type: string, handler: StorageEventHandler): void;
  removeEventListener(type: string, handler: StorageEventHandler): void;
  /** Fire a `storage` event, as another tab would. */
  fireStorage(key: string | null): void;
  /** How many `storage` handlers are currently attached (the DOM Set-like dedup). */
  storageListenerCount(): number;
  store: Map<string, string>;
  failNextSet?: boolean;
  failRead?: boolean;
}

function makeFakeWindow(initial?: Partial<Record<string, string>>): FakeWindow {
  const store = new Map<string, string>(Object.entries(initial ?? {}) as [string, string][]);
  const handlers = new Map<string, Set<StorageEventHandler>>();
  const win: FakeWindow = {
    localStorage: {
      getItem: (k) => {
        if (win.failRead) throw new Error('storage blocked');
        return store.get(k) ?? null;
      },
      setItem: (k, v) => {
        if (win.failNextSet) {
          win.failNextSet = false;
          throw new Error('quota exceeded');
        }
        store.set(k, String(v));
      },
      removeItem: (k) => {
        store.delete(k);
      },
    },
    addEventListener: (type, handler) => {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type)!.add(handler);
    },
    removeEventListener: (type, handler) => {
      handlers.get(type)?.delete(handler);
    },
    fireStorage: (key) => {
      for (const h of [...(handlers.get('storage') ?? [])]) h({ key });
    },
    storageListenerCount: () => handlers.get('storage')?.size ?? 0,
    store,
  };
  return win;
}

function withWindow<T>(win: FakeWindow | null, run: () => T): T {
  const global = globalThis as { window?: unknown };
  const had = 'window' in global;
  const prev = global.window;
  if (win) global.window = win;
  else delete global.window;
  try {
    return run();
  } finally {
    if (had) global.window = prev;
    else delete global.window;
  }
}

describe('CHAT-SEND-KEY enter_sends gestures (default mode)', () => {
  it('Enter sends; Shift+Enter is left to the textarea as a newline', () => {
    assert.equal(resolveSendKeyGesture(enter(), { mode: 'enter_sends' }), 'send');
    assert.equal(resolveSendKeyGesture(enter({ shiftKey: true }), { mode: 'enter_sends' }), null);
    assert.equal(resolveSendKeyGesture(enter({ shiftKey: true }), { mode: 'enter_sends', runOpen: true }), null);
  });

  it('a modified Enter NEVER sends when idle — the key is left to the browser/OS', () => {
    for (const mod of ['ctrlKey', 'metaKey', 'altKey'] as const) {
      assert.equal(resolveSendKeyGesture(enter({ [mod]: true }), { mode: 'enter_sends' }), null, `${mod}+Enter must not send`);
      // and the same for a bare `mode` left unset (the default)
      assert.equal(resolveSendKeyGesture(enter({ [mod]: true })), null, `${mod}+Enter defaults to no send`);
    }
  });

  it('a modified Enter steers while a run is open (the shipped steer gesture)', () => {
    for (const mod of ['ctrlKey', 'metaKey', 'altKey'] as const) {
      assert.equal(resolveSendKeyGesture(enter({ [mod]: true }), { mode: 'enter_sends', runOpen: true }), 'steer');
    }
    assert.equal(resolveSendKeyGesture(enter(), { mode: 'enter_sends', runOpen: true }), 'send');
  });

  it('IME composition swallows Enter; so does any non-Enter key', () => {
    assert.equal(resolveSendKeyGesture(enter({ isComposing: true }), { mode: 'enter_sends' }), null);
    assert.equal(resolveSendKeyGesture(enter({ nativeEvent: { isComposing: true } }), { mode: 'enter_sends' }), null);
    assert.equal(resolveSendKeyGesture(enter({ isComposing: true }), { mode: 'enter_sends', runOpen: true }), null);
    assert.equal(resolveSendKeyGesture({ key: 'a' }, { mode: 'enter_sends' }), null);
    assert.equal(resolveSendKeyGesture({ key: 'Tab' }, { mode: 'enter_sends' }), null);
  });
});

describe('CHAT-SEND-KEY mod_enter_sends gestures', () => {
  it('plain Enter is a newline, never a send', () => {
    assert.equal(resolveSendKeyGesture(enter(), { mode: 'mod_enter_sends' }), null);
    assert.equal(resolveSendKeyGesture(enter({ shiftKey: true }), { mode: 'mod_enter_sends' }), null);
    assert.equal(resolveSendKeyGesture(enter(), { mode: 'mod_enter_sends', runOpen: true }), null);
  });

  it('Ctrl/Cmd+Enter sends when idle and steers while a run is open', () => {
    assert.equal(resolveSendKeyGesture(enter({ ctrlKey: true }), { mode: 'mod_enter_sends' }), 'send');
    assert.equal(resolveSendKeyGesture(enter({ metaKey: true }), { mode: 'mod_enter_sends' }), 'send');
    assert.equal(resolveSendKeyGesture(enter({ ctrlKey: true }), { mode: 'mod_enter_sends', runOpen: true }), 'steer');
    assert.equal(resolveSendKeyGesture(enter({ metaKey: true }), { mode: 'mod_enter_sends', runOpen: true }), 'steer');
  });

  it('Alt+Enter is not the send gesture, and Shift+Ctrl/Cmd+Enter is still a newline', () => {
    assert.equal(resolveSendKeyGesture(enter({ altKey: true }), { mode: 'mod_enter_sends' }), null);
    assert.equal(resolveSendKeyGesture(enter({ altKey: true, metaKey: true }), { mode: 'mod_enter_sends' }), 'send');
    assert.equal(resolveSendKeyGesture(enter({ shiftKey: true, ctrlKey: true }), { mode: 'mod_enter_sends' }), null);
    assert.equal(resolveSendKeyGesture(enter({ shiftKey: true, metaKey: true }), { mode: 'mod_enter_sends' }), null);
  });

  it('IME composition swallows even the send combo', () => {
    assert.equal(resolveSendKeyGesture(enter({ ctrlKey: true, isComposing: true }), { mode: 'mod_enter_sends' }), null);
    assert.equal(
      resolveSendKeyGesture(enter({ metaKey: true, nativeEvent: { isComposing: true } }), { mode: 'mod_enter_sends' }),
      null,
    );
  });

  it('Alt+Enter keeps steering while a run is open', () => {
    assert.equal(resolveSendKeyGesture(enter({ altKey: true }), { mode: 'mod_enter_sends', runOpen: true }), 'steer');
  });
});

describe('CHAT-SEND-KEY mode parsing', () => {
  it('only the two modes are valid; anything else falls back to enter_sends', () => {
    assert.deepEqual([...CHAT_SEND_KEY_MODES], ['enter_sends', 'mod_enter_sends']);
    assert.equal(DEFAULT_CHAT_SEND_KEY_MODE, 'enter_sends');
    assert.equal(isChatSendKeyMode('enter_sends'), true);
    assert.equal(isChatSendKeyMode('mod_enter_sends'), true);
    assert.equal(isChatSendKeyMode('enter'), false);
    assert.equal(isChatSendKeyMode(undefined), false);
    assert.equal(isChatSendKeyMode(null), false);
    assert.equal(chatSendKeyModeOrDefault('bogus'), 'enter_sends');
    assert.equal(chatSendKeyModeOrDefault(undefined), 'enter_sends');
    assert.equal(chatSendKeyModeOrDefault('mod_enter_sends'), 'mod_enter_sends');
  });

  it('an unparsable mode behaves as the default in the gesture helper', () => {
    assert.equal(resolveSendKeyGesture(enter(), { mode: 'send-on-numpad' }), 'send');
    assert.equal(resolveSendKeyGesture(enter({ ctrlKey: true }), { mode: 'send-on-numpad' }), null);
  });
});

describe('CHAT-SEND-KEY stored preference', () => {
  it('server render (no window) reads the default and writes nothing', () => {
    assert.equal(withWindow(null, () => readChatSendKeyMode()), 'enter_sends');
    assert.doesNotThrow(() => withWindow(null, () => writeChatSendKeyMode('mod_enter_sends')));
  });

  it('reads the stored mode; unknown values and a throwing storage fall back to the default', () => {
    assert.equal(withWindow(makeFakeWindow({ [CHAT_SEND_KEY_STORAGE_KEY]: 'mod_enter_sends' }), readChatSendKeyMode), 'mod_enter_sends');
    assert.equal(withWindow(makeFakeWindow({ [CHAT_SEND_KEY_STORAGE_KEY]: 'enter_sends' }), readChatSendKeyMode), 'enter_sends');
    for (const junk of ['shift_sends', '', 'ENTER_SENDS', 'null']) {
      assert.equal(withWindow(makeFakeWindow({ [CHAT_SEND_KEY_STORAGE_KEY]: junk }), readChatSendKeyMode), 'enter_sends', junk);
    }
    assert.equal(withWindow(makeFakeWindow(), readChatSendKeyMode), 'enter_sends');
    const broken = makeFakeWindow({ [CHAT_SEND_KEY_STORAGE_KEY]: 'mod_enter_sends' });
    broken.failRead = true; // privacy mode: localStorage access throws
    assert.equal(withWindow(broken, () => readChatSendKeyMode()), 'enter_sends');
  });

  it('write persists the mode (and ignores unknown modes)', () => {
    const win = makeFakeWindow();
    withWindow(win, () => writeChatSendKeyMode('mod_enter_sends'));
    assert.equal(win.store.get(CHAT_SEND_KEY_STORAGE_KEY), 'mod_enter_sends');
    withWindow(win, () => writeChatSendKeyMode('shift_sends' as never));
    assert.equal(win.store.get(CHAT_SEND_KEY_STORAGE_KEY), 'mod_enter_sends', 'unknown mode never stored');
  });

  it('a storage failure still notifies subscribers (the in-memory flip works)', () => {
    const win = makeFakeWindow();
    const seen: string[] = [];
    const off = withWindow(win, () => subscribeChatSendKeyMode((m) => seen.push(m)));
    try {
      win.failNextSet = true;
      withWindow(win, () => writeChatSendKeyMode('mod_enter_sends'));
      assert.deepEqual(seen, ['mod_enter_sends']);
    } finally {
      off();
    }
  });
});

describe('CHAT-SEND-KEY live subscription', () => {
  const win = makeFakeWindow();
  let restore: () => void;

  before(() => {
    restore = installWindow(win);
  });
  after(() => restore());

  it('same-tab writes notify every subscriber', () => {
    const seenA: string[] = [];
    const seenB: string[] = [];
    const offA = subscribeChatSendKeyMode((m) => seenA.push(m));
    const offB = subscribeChatSendKeyMode((m) => seenB.push(m));
    try {
      writeChatSendKeyMode('mod_enter_sends');
      assert.deepEqual(seenA, ['mod_enter_sends']);
      assert.deepEqual(seenB, ['mod_enter_sends']);
      writeChatSendKeyMode('enter_sends');
      assert.deepEqual(seenA, ['mod_enter_sends', 'enter_sends']);
    } finally {
      offA();
      offB();
    }
  });

  it('unsubscribe stops the notifications', () => {
    const seen: string[] = [];
    const off = subscribeChatSendKeyMode((m) => seen.push(m));
    off();
    writeChatSendKeyMode('mod_enter_sends');
    assert.deepEqual(seen, []);
  });

  it('another tab writing the key re-reads the stored mode (cross-tab)', () => {
    const seen: string[] = [];
    const off = subscribeChatSendKeyMode((m) => seen.push(m));
    try {
      win.store.set(CHAT_SEND_KEY_STORAGE_KEY, 'mod_enter_sends');
      win.fireStorage(CHAT_SEND_KEY_STORAGE_KEY);
      assert.deepEqual(seen, ['mod_enter_sends']);
      win.store.set(CHAT_SEND_KEY_STORAGE_KEY, 'enter_sends');
      win.fireStorage(null); // storage.clear(): key is null, still our business
      assert.deepEqual(seen, ['mod_enter_sends', 'enter_sends']);
      win.fireStorage('tourbillon.chat.layoutMode'); // a different pref: no notification
      assert.deepEqual(seen, ['mod_enter_sends', 'enter_sends']);
    } finally {
      off();
    }
  });

  it('S296-S3: the shared window listener is ref-counted — a survivor hears cross-tab writes after another subscriber leaves', () => {
    // Fresh window so the handler-count assertions below are about THIS window's listeners.
    const w = makeFakeWindow();
    withWindow(w, () => {
      const seenA: string[] = [];
      const seenB: string[] = [];
      const offA = subscribeChatSendKeyMode((m) => seenA.push(m));
      const offB = subscribeChatSendKeyMode((m) => seenB.push(m));
      assert.equal(w.storageListenerCount(), 1, 'subscribers share ONE storage listener on the window');

      // A unmounts (thread switch, pane close) — and does it twice, as a sloppy caller may.
      offA();
      offA();

      // The cross-tab write must still reach the survivor: the DOM dedupes the identical handler,
      // so if A's unsubscribe tore it down, B would hear nothing until something remounted.
      w.store.set(CHAT_SEND_KEY_STORAGE_KEY, 'mod_enter_sends');
      w.fireStorage(CHAT_SEND_KEY_STORAGE_KEY);
      assert.deepEqual(seenB, ['mod_enter_sends'], 'B still hears the cross-tab write after A left');
      assert.deepEqual(seenA, [], 'the unsubscribed listener stays silent');

      // The last subscriber leaving must actually detach (no leaked window listener)…
      offB();
      assert.equal(w.storageListenerCount(), 0, 'the last unsubscribe detaches the shared listener');

      // …and a later subscriber must re-attach it.
      const seenC: string[] = [];
      const offC = subscribeChatSendKeyMode((m) => seenC.push(m));
      try {
        assert.equal(w.storageListenerCount(), 1, 'a new subscriber re-attaches the listener');
        w.store.set(CHAT_SEND_KEY_STORAGE_KEY, 'enter_sends');
        w.fireStorage(CHAT_SEND_KEY_STORAGE_KEY);
        assert.deepEqual(seenC, ['enter_sends']);
      } finally {
        offC();
        assert.equal(w.storageListenerCount(), 0, 'and unsubscribing it detaches again');
      }
    });
  });

  it('S300-S2: the same callback subscribed twice survives one unsubscribe (per-subscription tokens)', () => {
    // Fresh window so the handler-count assertions below are about THIS window's listeners.
    const w = makeFakeWindow();
    withWindow(w, () => {
      const seen: ChatSendKeyMode[] = [];
      const shared = (mode: ChatSendKeyMode) => {
        seen.push(mode);
      };
      // One and the same function subscribed twice (possible for any consumer of the exported
      // store, though not via useChatSendKeyMode, which passes a fresh closure per subscriber).
      const offFirst = subscribeChatSendKeyMode(shared);
      const offSecond = subscribeChatSendKeyMode(shared);
      assert.equal(w.storageListenerCount(), 1, 'both subscriptions share ONE storage listener on the window');

      // The first subscription leaves; the second still holds the callback.
      offFirst();

      w.store.set(CHAT_SEND_KEY_STORAGE_KEY, 'mod_enter_sends');
      w.fireStorage(CHAT_SEND_KEY_STORAGE_KEY);
      assert.deepEqual(seen, ['mod_enter_sends'], 'the live second subscription still delivers to the shared callback');
      assert.equal(w.storageListenerCount(), 1, 'the window listener stays attached while one subscription lives');

      // The second subscription leaving must go silent AND detach the shared listener.
      offSecond();
      w.store.set(CHAT_SEND_KEY_STORAGE_KEY, 'enter_sends');
      w.fireStorage(CHAT_SEND_KEY_STORAGE_KEY);
      assert.deepEqual(seen, ['mod_enter_sends'], 'after the last unsubscribe the callback stops firing');
      assert.equal(w.storageListenerCount(), 0, 'and the last unsubscribe detaches the window listener');
    });
  });
});

describe('CHAT-SEND-KEY settings copy', () => {
  it('the settings control is labelled "Send message with" with one label + description per mode', () => {
    assert.equal(CHAT_SEND_KEY_SETTINGS_LABEL, 'Send message with');
    assert.equal(CHAT_SEND_KEY_MODE_LABELS.enter_sends, 'Enter');
    assert.equal(CHAT_SEND_KEY_MODE_LABELS.mod_enter_sends, 'Ctrl/Cmd+Enter');
    assert.match(CHAT_SEND_KEY_MODE_DESCRIPTIONS.enter_sends, /Shift\+Enter/);
    assert.match(CHAT_SEND_KEY_MODE_DESCRIPTIONS.mod_enter_sends, /Enter starts a new line/);
  });

  it('the hint reflects the active mode (default copy unchanged)', () => {
    assert.equal(chatSendKeyHint('enter_sends'), 'Enter to send, Shift+Enter for a new line');
    assert.equal(chatSendKeyHint('enter_sends', { running: true }), 'Enter queues, Ctrl+Enter steers');
    assert.equal(chatSendKeyHint('mod_enter_sends'), 'Ctrl/Cmd+Enter to send, Enter for a new line');
    assert.equal(chatSendKeyHint('mod_enter_sends', { running: true }), 'Ctrl/Cmd+Enter steers, Enter for a new line');
    // unparsable stored value → the default copy
    assert.equal(chatSendKeyHint('nonsense'), 'Enter to send, Shift+Enter for a new line');
  });
});

/** Install a fake window for the lifetime of a describe block (module-level listeners are shared). */
function installWindow(win: FakeWindow): () => void {
  const global = globalThis as { window?: unknown };
  const had = 'window' in global;
  const prev = global.window;
  global.window = win;
  return () => {
    if (had) global.window = prev;
    else delete global.window;
  };
}
