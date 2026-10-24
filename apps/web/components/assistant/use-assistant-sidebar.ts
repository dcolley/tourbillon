'use client';

/** UI-2b: binds the assistant sidebar store to React; loads agents and threads on mount. */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { createAssistantSidebarApi, type AssistantSidebarApi } from '@/lib/assistant/sidebar-api';
import { AssistantSidebarStore, initialSidebarState } from '@/lib/assistant/sidebar-store';

const initial = () => initialSidebarState;

export function useAssistantSidebar(opts: { api?: AssistantSidebarApi } = {}) {
  const [store] = useState(() => new AssistantSidebarStore({ api: opts.api ?? createAssistantSidebarApi() }));
  useEffect(() => {
    void store.load();
    return () => store.dispose();
  }, [store]);
  const state = useSyncExternalStore(store.subscribe, store.getState, initial);
  return { store, state };
}
