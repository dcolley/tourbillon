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
import { isControlChatEnabled } from '@/lib/feature-flags';

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
  handleAgentSwitch: (agentId: string, agentName: string) => void;
  /** Server-side active company ID (from cookie); used to detect company changes. */
  activeCompanyId: string | null;
}

/** Exported for tests only; app code uses `useChatUi` / `useChatUiOptional`. */
export const ChatUiContext = createContext<ChatUiContextValue | null>(null);

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

/**
 * Layout the provider uses after mount. With the Control Pane chat flag off a saved layout
 * (e.g. 'sidebar') is ignored, so it cannot auto-open or dock the pane.
 */
export function resolveChatLayoutMode(
  chatEnabled: boolean,
  readSaved: () => ChatLayoutMode = readChatLayoutMode,
): ChatLayoutMode {
  return chatEnabled ? readSaved() : 'fab';
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

/**
 * Chat state for dashboard pages. Always provides the context (so `ChatPageContext` callers
 * keep working), but the chat UI itself (popover pane, floating button, docked sidebar via
 * `ChatSidebarSlot`) only renders when `NEXT_PUBLIC_CONTROL_CHAT_ENABLED=true` (UI-0).
 */
export function ChatContextProvider({
  children,
  activeCompanyId: serverActiveCompanyId,
  initialPageContext = null,
}: {
  children: ReactNode;
  activeCompanyId: string | null;
  /** Optional starting page context (normally set by `ChatPageContext` after mount). */
  initialPageContext?: ChatUiContextValue['pageContext'];
}) {
  // Build-time flag: constant for the life of the bundle.
  const chatEnabled = isControlChatEnabled();
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<ChatOpenTarget | null>(null);
  const [pageContext, setPageContextState] =
    useState<ChatUiContextValue['pageContext']>(initialPageContext);
  // Flag off: stay in 'fab' and ignore a saved layout, so a stored 'sidebar' cannot
  // auto-open or dock the pane.
  const [layoutMode, setLayoutModeState] = useState<ChatLayoutMode>(
    chatEnabled ? 'sidebar' : 'fab',
  );
  const [pinnedAgentId, setPinnedAgentId] = useState<string | null>(null);
  const [trackedCompanyId, setTrackedCompanyId] = useState<string | null>(serverActiveCompanyId);

  useEffect(() => {
    setLayoutModeState(resolveChatLayoutMode(chatEnabled));
  }, [chatEnabled]);

  // Reset chat state when server-side active company changes
  useEffect(() => {
    if (trackedCompanyId !== null && serverActiveCompanyId !== trackedCompanyId) {
      setPinnedAgentId(null);
      setTarget(null);
    }
    setTrackedCompanyId(serverActiveCompanyId);
  }, [serverActiveCompanyId, trackedCompanyId]);

  const openChat = useCallback((next: ChatOpenTarget) => {
    setTarget(next);
    setPinnedAgentId(next.agentId);
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

  // Sidebar mode: bind target to page context, but respect pinned agent.
  // Exception: agent pages select that agent when arriving (product requirement).
  useEffect(() => {
    if (!chatEnabled || layoutMode !== 'sidebar') return;
    const fromPage = targetFromPageContext(pageContext);
    if (!fromPage) return;
    setTarget((prev) => {
      // Already showing this exact room + agent → no change.
      if (
        prev &&
        prev.agentId === fromPage.agentId &&
        prev.contextType === fromPage.contextType &&
        prev.contextId === fromPage.contextId
      ) {
        return prev;
      }
      // Agent page: arriving IS picking the agent. Override pin only when arriving.
      if (pageContext?.contextType === 'agent') {
        const arrivingAtAgentPage =
          !prev ||
          prev.contextType !== 'agent' ||
          prev.contextId !== fromPage.contextId;
        if (arrivingAtAgentPage) {
          setPinnedAgentId(fromPage.agentId);
          return fromPage;
        }
        // Already on this agent page → keep current target (switcher choice).
        return prev;
      }
      // User pinned an agent → keep that agent, update room context only.
      if (pinnedAgentId && prev) {
        return {
          ...prev,
          contextType: fromPage.contextType,
          contextId: fromPage.contextId,
          contextTitle: fromPage.contextTitle,
        };
      }
      // No pin → use page default agent + context.
      return fromPage;
    });
    setOpen(true);
  }, [chatEnabled, layoutMode, pageContext, pinnedAgentId]);

  const handleAgentSwitch = useCallback((agentId: string, agentName: string) => {
    setPinnedAgentId(agentId);
    setTarget((prev) =>
      prev
        ? { ...prev, agentId, agentName }
        : { agentId, agentName, contextType: 'free' },
    );
  }, []);

  const actions = useMemo(
    () => ({ openChat, closeChat, setPageContext, setLayoutMode, handleAgentSwitch }),
    [openChat, closeChat, setPageContext, setLayoutMode, handleAgentSwitch],
  );

  const value = useMemo(
    () => ({ ...actions, pageContext, layoutMode, target, open, activeCompanyId: serverActiveCompanyId }),
    [actions, pageContext, layoutMode, target, open, serverActiveCompanyId],
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
    chatEnabled &&
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
        onAgentSwitch={handleAgentSwitch}
        activeCompanyId={serverActiveCompanyId}
      />
    ) : null);

  return (
    <ChatUiContext.Provider value={value}>
      {children}
      {pane}
      {chatEnabled ? <ChatFab /> : null}
    </ChatUiContext.Provider>
  );
}

/**
 * Docked chat for `layoutMode === 'sidebar'` — render inside the dashboard shell.
 * Renders nothing while the Control Pane chat flag is off (UI-0), whatever layout is saved.
 */
export function ChatSidebarSlot() {
  const chat = useChatUiOptional();
  if (!chat || !isControlChatEnabled()) return null;
  const { layoutMode, open, target, setLayoutMode, handleAgentSwitch, activeCompanyId } = chat;
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
      onAgentSwitch={handleAgentSwitch}
      activeCompanyId={activeCompanyId}
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
