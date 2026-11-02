'use client';

/**
 * CHAT-SEND-KEY: the browser's "Send message with" mode, live.
 *
 * The preference is an external store (localStorage + its listeners), so it is read the canonical
 * way — subscribe plus snapshot. Server render and the client's first paint both report the default,
 * from the first client render the snapshot returns the stored value, and every later change
 * (same-tab write or another tab's `storage` event) re-renders subscribers — so flipping the setting
 * re-binds open composers without a reload, with no setState-in-effect cascade.
 */
import { useCallback, useSyncExternalStore } from 'react';
import {
  DEFAULT_CHAT_SEND_KEY_MODE,
  readChatSendKeyMode,
  subscribeChatSendKeyMode,
  writeChatSendKeyMode,
  type ChatSendKeyMode,
} from '@/lib/chat-send-key';

function getServerSnapshot(): ChatSendKeyMode {
  return DEFAULT_CHAT_SEND_KEY_MODE;
}

export function useChatSendKeyMode(): [ChatSendKeyMode, (mode: ChatSendKeyMode) => void] {
  const subscribe = useCallback(
    (onStoreChange: () => void) => subscribeChatSendKeyMode(onStoreChange),
    [],
  );
  const getSnapshot = useCallback(() => readChatSendKeyMode(), []);
  const mode = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const setSendKeyMode = useCallback((next: ChatSendKeyMode) => {
    writeChatSendKeyMode(next); // notifies every subscriber, including this hook
  }, []);

  return [mode, setSendKeyMode];
}
