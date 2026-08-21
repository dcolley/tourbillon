'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { AgentChatPane } from './agent-chat-pane';
import type { ChatContextType } from './use-agent-chat-session';
import { Button } from '@/components/ui/button';
import { MessageSquare } from 'lucide-react';
import {
  readChatLayoutMode,
  writeChatLayoutMode,
  type ChatLayoutMode,
} from '@/lib/chat-layout-storage';

export interface ChatOpenTarget {
  agentId: string;
  agentName: string;
  contextType?: ChatContextType;
  contextId?: string;
  contextTitle?: string;
}

interface ChatUiContextValue {
  openChat: (target: ChatOpenTarget) => void;
  closeChat: () => void;
  setPageContext: (ctx: {
    contextType: ChatContextType;
    contextId?: string;
    contextTitle?: string;
    defaultAgentId?: string;
    defaultAgentName?: string;
  } | null) => void;
  pageContext: {
    contextType: ChatContextType;
    contextId?: string;
    contextTitle?: string;
    defaultAgentId?: string;
    defaultAgentName?: string;
  } | null;
  layoutMode: ChatLayoutMode;
  setLayoutMode: (mode: ChatLayoutMode) => void;
  /** Current chat target when a session is active (open or sidebar-docked). */
  target: ChatOpenTarget | null;
  open: boolean;
}

const ChatUiContext = createContext<ChatUiContextValue | null>(null);

export function useChatUi(): ChatUiContextValue {
  const ctx = useContext(ChatUiContext);
  if (!ctx) {
    throw new Error('useChatUi must be used within ChatContextProvider');
  }
  return ctx;
}

/** Optional hook that returns null outside the provider (e.g. non-dashboard pages). */
export function useChatUiOptional(): ChatUiContextValue | null {
  return useContext(ChatUiContext);
}

function targetFromPageContext(
  pageContext: ChatUiContextValue['pageContext'],
): ChatOpenTarget | null {
  if (!pageContext?.defaultAgentId || !pageContext.defaultAgentName) return null;
  return {
    agentId: pageContext.defaultAgentId,
    agentName: pageContext.defaultAgentName,
    contextType: pageContext.contextType,
    contextId: pageContext.contextId,
    contextTitle: pageContext.contextTitle,
  };
}

export function ChatContextProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<ChatOpenTarget | null>(null);
  const [pageContext, setPageContextState] = useState<ChatUiContextValue['pageContext']>(null);
  const [layoutMode, setLayoutModeState] = useState<ChatLayoutMode>('sidebar');

  useEffect(() => {
    setLayoutModeState(readChatLayoutMode());
  }, []);

  const openChat = useCallback((next: ChatOpenTarget) => {
    setTarget(next);
    setOpen(true);
  }, []);

  const closeChat = useCallback(() => {
    setOpen(false);
  }, []);

  const setLayoutMode = useCallback(
    (mode: ChatLayoutMode) => {
      setLayoutModeState(mode);
      writeChatLayoutMode(mode);
      if (mode === 'fab') {
        setOpen(false);
        return;
      }
      if (mode === 'sidebar') {
        setTarget((prev) => prev ?? targetFromPageContext(pageContext));
        setOpen(true);
        return;
      }
      // popover: keep current open/target; opening is via FAB / openChat
    },
    [pageContext],
  );

  const setPageContext = useCallback<ChatUiContextValue['setPageContext']>((ctx) => {
    setPageContextState((prev) => {
      if (prev === ctx) return prev;
      if (prev == null || ctx == null) return ctx;
      if (
        prev.contextType === ctx.contextType &&
        prev.contextId === ctx.contextId &&
        prev.contextTitle === ctx.contextTitle &&
        prev.defaultAgentId === ctx.defaultAgentId &&
        prev.defaultAgentName === ctx.defaultAgentName
      ) {
        return prev;
      }
      return ctx;
    });
  }, []);

  // Sidebar mode: keep a target bound to the current page agent when available.
  useEffect(() => {
    if (layoutMode !== 'sidebar') return;
    const fromPage = targetFromPageContext(pageContext);
    if (!fromPage) return;
    setTarget((prev) => {
      if (
        prev &&
        prev.agentId === fromPage.agentId &&
        prev.contextType === fromPage.contextType &&
        prev.contextId === fromPage.contextId
      ) {
        return prev;
      }
      return fromPage;
    });
    setOpen(true);
  }, [layoutMode, pageContext]);

  const actions = useMemo(
    () => ({ openChat, closeChat, setPageContext, setLayoutMode }),
    [openChat, closeChat, setPageContext, setLayoutMode],
  );

  const value = useMemo(
    () => ({ ...actions, pageContext, layoutMode, target, open }),
    [actions, pageContext, layoutMode, target, open],
  );

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (!next && layoutMode === 'popover') {
        // Keep target so reopening is instant; clear only when leaving the page context.
      }
      if (!next && layoutMode === 'fab') {
        // Fab mode stays closed until FAB / openChat.
      }
      if (!next && layoutMode === 'sidebar') {
        // Closing sidebar switches to fab so the dock does not vanish without a way back.
        setLayoutModeState('fab');
        writeChatLayoutMode('fab');
      }
    },
    [layoutMode],
  );

  const pane =
    target &&
    (layoutMode === 'popover' || layoutMode === 'fab' ? (
      <AgentChatPane
        open={open}
        onOpenChange={handleOpenChange}
        agentId={target.agentId}
        agentName={target.agentName}
        contextType={target.contextType}
        contextId={target.contextId}
        contextTitle={target.contextTitle}
        presentation="popover"
        layoutMode={layoutMode}
        onLayoutModeChange={setLayoutMode}
      />
    ) : null);

  return (
    <ChatUiContext.Provider value={value}>
      {children}
      {pane}
      <ChatFab />
    </ChatUiContext.Provider>
  );
}

/** Docked chat for `layoutMode === 'sidebar'` — render inside the dashboard shell. */
export function ChatSidebarSlot() {
  const chat = useChatUiOptional();
  if (!chat) return null;
  const { layoutMode, open, target, setLayoutMode } = chat;
  if (layoutMode !== 'sidebar' || !target || !open) return null;

  return (
    <AgentChatPane
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          chat.closeChat();
          setLayoutMode('fab');
        }
      }}
      agentId={target.agentId}
      agentName={target.agentName}
      contextType={target.contextType}
      contextId={target.contextId}
      contextTitle={target.contextTitle}
      presentation="sidebar"
      layoutMode={layoutMode}
      onLayoutModeChange={setLayoutMode}
    />
  );
}

function ChatFab() {
  const { openChat, pageContext, open } = useChatUi();

  if (!pageContext?.defaultAgentId || !pageContext.defaultAgentName) {
    return null;
  }

  // Hide while the pane is visible (popover overlay or docked sidebar).
  if (open) {
    return null;
  }

  return (
    <Button
      type="button"
      size="icon-lg"
      className="fixed right-4 bottom-4 z-40 rounded-full shadow-md"
      title={`Chat with ${pageContext.defaultAgentName}`}
      onClick={() =>
        openChat({
          agentId: pageContext.defaultAgentId!,
          agentName: pageContext.defaultAgentName!,
          contextType: pageContext.contextType,
          contextId: pageContext.contextId,
          contextTitle: pageContext.contextTitle,
        })
      }
    >
      <MessageSquare className="size-5" />
      <span className="sr-only">Chat with agent</span>
    </Button>
  );
}
