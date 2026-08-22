'use client';

import { useEffect } from 'react';
import { useChatUiOptional, type ChatOpenTarget } from './chat-context';
import type { ChatContextType } from './use-agent-chat-session';

/** Registers page context for the FAB and contextual chat entry. */
export function ChatPageContext({
  contextType,
  contextId,
  contextTitle,
  defaultAgentId,
  defaultAgentName,
}: {
  contextType: ChatContextType;
  contextId?: string;
  contextTitle?: string;
  defaultAgentId?: string;
  defaultAgentName?: string;
}) {
  const chat = useChatUiOptional();
  // Depend on the stable setter only — not the whole context value (that
  // includes pageContext and would re-fire this effect forever).
  const setPageContext = chat?.setPageContext;

  useEffect(() => {
    if (!setPageContext) return;
    setPageContext({
      contextType,
      contextId,
      contextTitle,
      defaultAgentId,
      defaultAgentName,
    });
    return () => setPageContext(null);
  }, [setPageContext, contextType, contextId, contextTitle, defaultAgentId, defaultAgentName]);

  return null;
}

export type { ChatOpenTarget };
