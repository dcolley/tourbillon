'use client';

/**
 * UI-2b: binds the assistant sidebar store to React; loads agents (and, unless `threadLists: false`,
 * each agent's threads) on mount. ASYNC-0: the assistant sidebar loads agents only.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { createAssistantSidebarApi, type AssistantSidebarApi } from '@/lib/assistant/sidebar-api';
import { AssistantSidebarStore, initialSidebarState } from '@/lib/assistant/sidebar-store';

const initial = () => initialSidebarState;

export function useAssistantSidebar(opts: { api?: AssistantSidebarApi; threadLists?: boolean } = {}) {
  const [store] = useState(
    () => new AssistantSidebarStore({ api: opts.api ?? createAssistantSidebarApi(), threadLists: opts.threadLists }),
  );
  useEffect(() => {
    void store.load();
    return () => store.dispose();
  }, [store]);
  const state = useSyncExternalStore(store.subscribe, store.getState, initial);
  return { store, state };
}
