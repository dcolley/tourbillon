/**
 * CHAT-SEND-KEY: the one place that decides how a chat composer sends, and where the choice is stored.
 *
 * Two modes, one browser preference (localStorage, same pattern as `tourbillon.chat.layoutMode` in
 * lib/chat-layout-storage — a per-browser user pref, no DB column, no migration):
 *
 * - `enter_sends` (default, unchanged for existing users): Enter sends, Shift+Enter is a newline.
 * - `mod_enter_sends`: Enter is a newline, Ctrl/Cmd+Enter sends.
 *
 * Every composer keydown goes through `resolveSendKeyGesture` so the three send paths (the CHAT-1
 * composer controller, the assistant chat form, the Control-Pane chat pane) cannot drift apart:
 *
 * - Shift+Enter is never handled (the textarea inserts the newline itself) in either mode.
 * - Enter is ignored while an IME composition is active (`isComposing`) in both modes — confirming a
 *   candidate must not fire a send.
 * - Ctrl/Cmd/Alt+Enter is bound ONLY in the situations listed below. In particular, in `enter_sends`
 *   a modified Enter NEVER sends: with no run open the key is left completely alone (not even
 *   preventDefault), so the browser and the OS keep it.
 * - Ctrl/Cmd/Alt+Enter steers while a run is open in both modes: that is the shipped steer gesture
 *   (the composer hint advertises it) and plain Enter cannot reach steer, so it is kept — the mode
 *   choice is about send vs. newline, not about taking the interrupt key away.
 * - In `mod_enter_sends` plain Enter returns null, i.e. the newline is inserted by the textarea.
 *
 * Subscribers are notified on every write (same tab) and on the `storage` event (other tabs), so
 * flipping the setting changes the binding live — no reload.
 */
export const CHAT_SEND_KEY_STORAGE_KEY = 'tourbillon.chat.sendKey';

export const CHAT_SEND_KEY_MODES = ['enter_sends', 'mod_enter_sends'] as const;

export type ChatSendKeyMode = (typeof CHAT_SEND_KEY_MODES)[number];

/** Existing users keep today's behaviour: Enter sends. Anything unparsable falls back to this. */
export const DEFAULT_CHAT_SEND_KEY_MODE: ChatSendKeyMode = 'enter_sends';

/** Settings UI copy ("Send message with"). */
export const CHAT_SEND_KEY_SETTINGS_LABEL = 'Send message with';

export const CHAT_SEND_KEY_MODE_LABELS: Record<ChatSendKeyMode, string> = {
  enter_sends: 'Enter',
  mod_enter_sends: 'Ctrl/Cmd+Enter',
};

export const CHAT_SEND_KEY_MODE_DESCRIPTIONS: Record<ChatSendKeyMode, string> = {
  enter_sends: 'Enter sends, Shift+Enter starts a new line',
  mod_enter_sends: 'Ctrl/Cmd+Enter sends, Enter starts a new line',
};

export function isChatSendKeyMode(value: unknown): value is ChatSendKeyMode {
  return (
    typeof value === 'string' &&
    (CHAT_SEND_KEY_MODES as readonly string[]).includes(value)
  );
}

/** Unknown / missing / corrupt values fall back to the default mode. */
export function chatSendKeyModeOrDefault(value: unknown): ChatSendKeyMode {
  return isChatSendKeyMode(value) ? value : DEFAULT_CHAT_SEND_KEY_MODE;
}

export function readChatSendKeyMode(): ChatSendKeyMode {
  if (typeof window === 'undefined') return DEFAULT_CHAT_SEND_KEY_MODE;
  try {
    return chatSendKeyModeOrDefault(window.localStorage.getItem(CHAT_SEND_KEY_STORAGE_KEY));
  } catch {
    // storage unavailable (privacy mode, quota): the default
    return DEFAULT_CHAT_SEND_KEY_MODE;
  }
}

export function writeChatSendKeyMode(mode: ChatSendKeyMode): void {
  if (typeof window === 'undefined' || !isChatSendKeyMode(mode)) return;
  try {
    window.localStorage.setItem(CHAT_SEND_KEY_STORAGE_KEY, mode);
  } catch {
    // ignore: the in-memory listeners below still get the new mode
  }
  emit(mode);
}

type ChatSendKeyListener = (mode: ChatSendKeyMode) => void;

const listeners = new Set<ChatSendKeyListener>();

function emit(mode: ChatSendKeyMode): void {
  for (const listener of [...listeners]) listener(mode);
}

function onStorageEvent(event: StorageEvent): void {
  // `key` is null when storage was cleared entirely.
  if (event.key !== null && event.key !== CHAT_SEND_KEY_STORAGE_KEY) return;
  emit(readChatSendKeyMode());
}

/**
 * Subscribe to preference changes (same-tab writes and other tabs' `storage` events). Returns an
 * unsubscribe function. Each subscription holds its own `storage` listener (the DOM dedupes the
 * identical handler per window), so a subscription always hears the window it was created against.
 */
export function subscribeChatSendKeyMode(listener: ChatSendKeyListener): () => void {
  listeners.add(listener);
  const owner = typeof window === 'undefined' ? null : window;
  owner?.addEventListener('storage', onStorageEvent);
  return () => {
    listeners.delete(listener);
    owner?.removeEventListener('storage', onStorageEvent);
  };
}

/** Minimal keydown shape (React synthetic events and the controller's KeyLike both satisfy it). */
export interface SendKeyEventLike {
  key: string;
  shiftKey?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  isComposing?: boolean;
  nativeEvent?: { isComposing?: boolean } | null;
}

export interface SendKeyGestureOptions {
  /** Stored value is handed over raw: anything unparsable means the default mode. */
  mode?: unknown;
  /** A run is open (the composer queues follow-ups / steers instead of starting a turn). */
  runOpen?: boolean;
}

/**
 * What a keydown asks for: start/queue a message, steer the open run, or nothing at all (null —
 * the caller must not preventDefault then, so the key reaches the textarea, the browser or the OS).
 */
export type SendKeyGesture = 'send' | 'steer' | null;

export function resolveSendKeyGesture(
  event: SendKeyEventLike,
  options: SendKeyGestureOptions = {},
): SendKeyGesture {
  if (event.key !== 'Enter' || event.shiftKey) return null;
  // IME: Enter confirms a composition candidate, it is not a send.
  if (event.isComposing || event.nativeEvent?.isComposing) return null;

  const modified = Boolean(event.ctrlKey || event.metaKey || event.altKey);

  if (chatSendKeyModeOrDefault(options.mode) === 'mod_enter_sends') {
    // Ctrl/Cmd is the send gesture (Alt is left to the browser/OS); while a run is open the
    // modified Enter keeps steering, as it always has.
    if (event.ctrlKey || event.metaKey) return options.runOpen ? 'steer' : 'send';
    if (event.altKey) return options.runOpen ? 'steer' : null;
    return null;
  }

  // enter_sends: plain Enter sends; a modified Enter never sends.
  if (modified) return options.runOpen ? 'steer' : null;
  return 'send';
}

/** Composer hint under the textarea, reflecting the active mode. */
export function chatSendKeyHint(mode: unknown, options: { running?: boolean } = {}): string {
  if (chatSendKeyModeOrDefault(mode) === 'mod_enter_sends') {
    return options.running
      ? 'Ctrl/Cmd+Enter steers, Enter for a new line'
      : 'Ctrl/Cmd+Enter to send, Enter for a new line';
  }
  return options.running
    ? 'Enter queues, Ctrl+Enter steers'
    : 'Enter to send, Shift+Enter for a new line';
}
