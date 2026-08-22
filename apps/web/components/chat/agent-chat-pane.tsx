'use client';

import { useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import {
  Clock,
  PanelRight,
  PanelLeftClose,
  AppWindow,
  CircleDot,
  MoreHorizontal,
  Pencil,
  Trash2,
  XIcon,
  ChevronDown,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { MarkdownContent } from '@/components/markdown-content';
import { cn } from '@/lib/utils';
import {
  CHAT_LAYOUT_MODE_LABELS,
  type ChatLayoutMode,
} from '@/lib/chat-layout-storage';
import {
  chatMessagePlainText,
  formatChatMessageDateTime,
  isChatUserMessage,
  useAgentChatSession,
  type ChatAgentOption,
  type ChatContextType,
  type ChatThreadInfo,
} from './use-agent-chat-session';
import {
  ChatSidebarResizeHandle,
  useChatSidebarWidth,
} from './chat-sidebar-resize';

function agentInferenceLabel(agent: Pick<ChatAgentOption, 'providerName' | 'modelId'>): string | null {
  const provider = agent.providerName?.trim();
  const model = agent.modelId?.trim();
  if (provider && model) return `${provider} · ${model}`;
  if (provider) return provider;
  if (model) return model;
  return null;
}

const SESSIONS_STORAGE_KEY = 'tourbillon.chat.sessionsOpen';

function readSessionsOpen(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const stored = window.localStorage.getItem(SESSIONS_STORAGE_KEY);
    return stored === 'true';
  } catch {
    return false;
  }
}

function writeSessionsOpen(open: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SESSIONS_STORAGE_KEY, String(open));
  } catch {
    // ignore
  }
}

export type ChatPanePresentation = 'popover' | 'sidebar';

export function AgentChatPane({
  open,
  onOpenChange,
  agentId,
  agentName,
  contextType = 'free',
  contextId,
  contextTitle,
  presentation = 'popover',
  layoutMode,
  onLayoutModeChange,
  onAgentSwitch,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentId: string;
  agentName: string;
  contextType?: ChatContextType;
  contextId?: string;
  contextTitle?: string;
  presentation?: ChatPanePresentation;
  layoutMode: ChatLayoutMode;
  onLayoutModeChange: (mode: ChatLayoutMode) => void;
  onAgentSwitch?: (agentId: string, agentName: string) => void;
}) {
  const session = useAgentChatSession({
    agentId,
    agentName,
    open,
    contextType,
    contextId,
    contextTitle,
    onAgentSwitch,
  });

  const bottomRef = useRef<HTMLDivElement>(null);
  const { width, dragging, onResizePointerDown, onResizeKeyDown } = useChatSidebarWidth();

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [session.messages, session.running]);

  if (presentation === 'sidebar') {
    if (!open) return null;
    return (
      <aside
        className={cn(
          'relative flex h-full shrink-0 flex-col border-l bg-background',
          'max-md:fixed max-md:inset-y-0 max-md:right-0 max-md:z-40 max-md:w-full max-md:max-w-lg max-md:shadow-lg',
          dragging && 'select-none',
        )}
        style={{ width }}
        data-chat-sidebar
      >
        <ChatSidebarResizeHandle
          dragging={dragging}
          onPointerDown={onResizePointerDown}
          onKeyDown={onResizeKeyDown}
        />
        <ChatPaneBody
          agentName={agentName}
          contextType={contextType}
          contextTitle={contextTitle}
          session={session}
          bottomRef={bottomRef}
          layoutMode={layoutMode}
          onLayoutModeChange={onLayoutModeChange}
          onClose={() => onOpenChange(false)}
          showClose
        />
      </aside>
    );
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 p-0 sm:max-w-lg"
        showCloseButton={false}
      >
        <ChatPaneBody
          agentName={agentName}
          contextType={contextType}
          contextTitle={contextTitle}
          session={session}
          bottomRef={bottomRef}
          layoutMode={layoutMode}
          onLayoutModeChange={onLayoutModeChange}
          onClose={() => onOpenChange(false)}
          showClose
          sheetHeader
        />
      </SheetContent>
    </Sheet>
  );
}

function ChatPaneBody({
  agentName,
  contextType,
  contextTitle,
  session,
  bottomRef,
  layoutMode,
  onLayoutModeChange,
  onClose,
  showClose,
  sheetHeader,
}: {
  agentName: string;
  contextType: ChatContextType;
  contextTitle?: string;
  session: ReturnType<typeof useAgentChatSession>;
  bottomRef: RefObject<HTMLDivElement | null>;
  layoutMode: ChatLayoutMode;
  onLayoutModeChange: (mode: ChatLayoutMode) => void;
  onClose?: () => void;
  showClose?: boolean;
  sheetHeader?: boolean;
}) {
  const {
    threads,
    threadId,
    messages,
    running,
    connecting,
    error,
    pendingApproval,
    input,
    setInput,
    selectThread,
    newThread,
    renameThread,
    deleteThread,
    sendMessage,
    abort,
    steer,
    respondApproval,
    activeAgentId,
    activeAgentName,
    agentOptions,
    switchAgent,
  } = session;

  const [renameTarget, setRenameTarget] = useState<ChatThreadInfo | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ChatThreadInfo | null>(null);
  const [sessionsOpen, setSessionsOpen] = useState(false);

  useEffect(() => {
    setSessionsOpen(readSessionsOpen());
  }, []);

  const toggleSessions = () => {
    const next = !sessionsOpen;
    setSessionsOpen(next);
    writeSessionsOpen(next);
  };

  const contextLabel =
    contextType === 'free'
      ? 'General'
      : contextTitle
        ? `${contextType}: ${contextTitle}`
        : contextType;

  const description = `${contextLabel}${running ? ' · generating…' : connecting ? ' · connecting…' : ''}`;

  const active =
    agentOptions.find((a) => a.id === activeAgentId) ??
    ({
      id: activeAgentId,
      name: activeAgentName || agentName,
      urlKey: '',
    } satisfies ChatAgentOption);
  const inference = agentInferenceLabel(active);

  const headerInner = (
    <>
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={toggleSessions}
            title={sessionsOpen ? 'Hide sessions' : 'Show sessions'}
            aria-label={sessionsOpen ? 'Hide sessions' : 'Show sessions'}
          >
            <PanelLeftClose className={cn('size-4 transition-transform', sessionsOpen && 'rotate-180')} />
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  className="h-auto min-h-8 flex-1 justify-start gap-1.5 px-2 py-1 text-left font-normal"
                  disabled={connecting || running}
                />
              }
            >
              <span className="flex min-w-0 flex-1 items-center gap-1.5">
                <span className="truncate font-medium text-foreground">{active.name}</span>
                {inference && (
                  <span className="truncate text-xs text-muted-foreground">{inference}</span>
                )}
              </span>
              <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-60">
              {(agentOptions.length === 0
                ? [active]
                : agentOptions
              ).map((a) => {
                const inf = agentInferenceLabel(a);
                return (
                  <DropdownMenuItem
                    key={a.id}
                    onClick={() => {
                      if (a.id !== activeAgentId) void switchAgent(a.id, a.name);
                    }}
                    className="flex items-center justify-between gap-2"
                  >
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="truncate font-medium">{a.name}</span>
                      {inf && (
                        <span className="truncate text-xs text-muted-foreground">{inf}</span>
                      )}
                    </span>
                    {a.id === activeAgentId && (
                      <CircleDot className="size-3 shrink-0 text-primary" />
                    )}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <ChatLayoutModeMenu
            layoutMode={layoutMode}
            onLayoutModeChange={onLayoutModeChange}
          />
          {showClose && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={onClose}
              title={sheetHeader ? 'Close chat' : 'Hide chat'}
              aria-label={sheetHeader ? 'Close chat' : 'Hide chat'}
            >
              <XIcon className="size-4" />
            </Button>
          )}
        </div>
      </div>
      {sheetHeader && (
        <SheetDescription className="sr-only">{description}</SheetDescription>
      )}
    </>
  );

  return (
    <>
    <div className="flex h-full min-h-0 flex-1 flex-col">
      {sheetHeader ? (
        <SheetHeader className="border-b">{headerInner}</SheetHeader>
      ) : (
        <div className="border-b px-4 py-3">{headerInner}</div>
      )}

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {sessionsOpen && (
          <aside className="flex w-[220px] shrink-0 flex-col border-r bg-muted/20">
            <div className="flex items-center justify-between gap-1 border-b p-2">
              <span className="text-xs font-medium text-muted-foreground">Sessions</span>
              <Button type="button" variant="ghost" size="xs" onClick={() => void newThread()}>
                New
              </Button>
            </div>
            <div className="flex-1 overflow-y-auto">
              <ul className="space-y-0.5 p-1">
                {threads.map((t) => (
                  <li key={t.id} className="group relative">
                    <button
                      type="button"
                      className={cn(
                        'w-full rounded-md py-1.5 pr-7 pl-2 text-left text-xs hover:bg-muted',
                        t.id === threadId && 'bg-muted font-medium',
                      )}
                      onClick={() => void selectThread(t.id)}
                    >
                      <span className="line-clamp-2">{t.title || 'New chat'}</span>
                    </button>
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-xs"
                            className={cn(
                              'absolute top-0.5 right-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 data-popup-open:opacity-100',
                              t.id === threadId && 'opacity-70',
                            )}
                            aria-label="Session options"
                            title="Session options"
                          />
                        }
                      >
                        <MoreHorizontal className="size-3.5" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" side="bottom" className="min-w-36">
                        <DropdownMenuItem
                          onClick={() => {
                            setRenameTarget(t);
                          }}
                        >
                          <Pencil />
                          Rename
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={() => {
                            setDeleteTarget(t);
                          }}
                        >
                          <Trash2 />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </li>
                ))}
                {threads.length === 0 && (
                  <li className="px-2 py-3 text-xs text-muted-foreground">No sessions yet</li>
                )}
              </ul>
            </div>
          </aside>
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex-1 overflow-y-auto px-3 py-3">
            <div className="space-y-3">
              {messages.map((m) => {
                const text = chatMessagePlainText(m);
                const isUser = isChatUserMessage(m);
                const isAssistant = m.role === 'assistant';
                if (!text && !isUser && !isAssistant) return null;
                const when = formatChatMessageDateTime(m.createdAt);
                return (
                  <div
                    key={m.id}
                    className={cn(
                      'flex items-end gap-1.5',
                      isUser ? 'justify-end' : 'justify-start',
                    )}
                  >
                    {!isUser && when && (
                      <MessageTimeIcon label={when} className="mb-1 text-muted-foreground" />
                    )}
                    <div
                      className={cn(
                        'max-w-[90%] rounded-lg px-3 py-2 text-sm',
                        isUser
                          ? 'bg-primary text-primary-foreground whitespace-pre-wrap'
                          : 'bg-muted text-foreground',
                      )}
                    >
                      {isUser ? (
                        text
                      ) : text ? (
                        <MarkdownContent content={text} showModeToggle={false} />
                      ) : (
                        '…'
                      )}
                    </div>
                    {isUser && when && (
                      <MessageTimeIcon
                        label={when}
                        className="mb-1 text-muted-foreground"
                      />
                    )}
                  </div>
                );
              })}
              {running && <ChatWorkingIndicator />}
              <div ref={bottomRef} />
            </div>
          </div>

          {error && (
            <div className="border-t border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}

          {pendingApproval && (
            <div className="flex items-center gap-2 border-t bg-muted/40 px-3 py-2 text-xs">
              <span className="flex-1 truncate">
                Approve tool <code>{pendingApproval.toolName}</code>?
              </span>
              <Button type="button" size="xs" onClick={() => void respondApproval(true)}>
                Approve
              </Button>
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={() => void respondApproval(false)}
              >
                Deny
              </Button>
            </div>
          )}

          <form
            className="border-t p-3"
            onSubmit={(e) => {
              e.preventDefault();
              void sendMessage(input);
            }}
          >
            <div className="flex items-end gap-2">
              <textarea
                className="min-h-[72px] w-full resize-none rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                placeholder={
                  running
                    ? 'Queue a follow-up while the agent is working…'
                    : 'Message the agent…'
                }
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void sendMessage(input);
                  }
                }}
                disabled={connecting}
              />
              <div className="flex shrink-0 flex-col gap-2">
                <Button type="submit" size="sm" disabled={connecting || !input.trim()}>
                  {running ? 'Queue' : 'Send'}
                </Button>
                {running && (
                  <>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={!input.trim()}
                      onClick={() => void steer(input)}
                    >
                      Steer
                    </Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => void abort()}>
                      Stop
                    </Button>
                  </>
                )}
              </div>
            </div>
          </form>
        </div>
      </div>
    </div>

    <RenameChatThreadDialog
      open={renameTarget !== null}
      thread={renameTarget}
      onOpenChange={(open) => {
        if (!open) setRenameTarget(null);
      }}
      onRename={renameThread}
    />
    <DeleteChatThreadDialog
      open={deleteTarget !== null}
      thread={deleteTarget}
      onOpenChange={(open) => {
        if (!open) setDeleteTarget(null);
      }}
      onDelete={deleteThread}
    />
    </>
  );
}

function RenameChatThreadDialog({
  open,
  thread,
  onOpenChange,
  onRename,
}: {
  open: boolean;
  thread: ChatThreadInfo | null;
  onOpenChange: (open: boolean) => void;
  onRename: (threadId: string, title: string) => Promise<void>;
}) {
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (open && thread) {
      setTitle(thread.title?.trim() || '');
      setError(null);
      setPending(false);
    }
  }, [open, thread]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!thread) return;
    const next = title.trim();
    if (!next) {
      setError('Title is required.');
      return;
    }
    setPending(true);
    setError(null);
    try {
      await onRename(thread.id, next);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to rename chat.');
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setError(null);
        onOpenChange(next);
      }}
    >
      <DialogContent className="flex max-h-[90vh] max-w-sm flex-col gap-0 overflow-hidden p-0 sm:max-w-sm">
        <form onSubmit={(e) => void handleSubmit(e)}>
          <DialogHeader className="border-b px-6 py-4">
            <DialogTitle>Rename chat</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 px-6 py-4">
            <div className="space-y-2">
              <Label htmlFor="chat-thread-title">Title</Label>
              <Input
                id="chat-thread-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                autoFocus
                maxLength={200}
              />
            </div>
            {error && (
              <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </div>
            )}
          </div>
          <DialogFooter className="border-t bg-background px-6 py-4">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteChatThreadDialog({
  open,
  thread,
  onOpenChange,
  onDelete,
}: {
  open: boolean;
  thread: ChatThreadInfo | null;
  onOpenChange: (open: boolean) => void;
  onDelete: (threadId: string) => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleDelete() {
    if (!thread) return;
    setPending(true);
    setError(null);
    try {
      await onDelete(thread.id);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete chat.');
    } finally {
      setPending(false);
    }
  }

  const label = thread?.title?.trim() || 'New chat';

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setError(null);
        onOpenChange(next);
      }}
    >
      <DialogContent className="flex max-h-[90vh] max-w-sm flex-col gap-0 overflow-hidden p-0 sm:max-w-sm">
        <DialogHeader className="border-b px-6 py-4">
          <DialogTitle>Delete chat</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 px-6 py-4 text-sm">
          <p>
            Delete <span className="font-medium">{label}</span>? This cannot be undone.
          </p>
          {error && (
            <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-destructive">
              {error}
            </div>
          )}
        </div>
        <DialogFooter className="border-t bg-background px-6 py-4">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={pending}
            onClick={() => void handleDelete()}
          >
            {pending ? 'Deleting…' : 'Delete'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ChatLayoutModeMenu({
  layoutMode,
  onLayoutModeChange,
}: {
  layoutMode: ChatLayoutMode;
  onLayoutModeChange: (mode: ChatLayoutMode) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            title="Chat layout"
            aria-label="Chat layout"
          />
        }
      >
        <PanelRight className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        <DropdownMenuRadioGroup
          value={layoutMode}
          onValueChange={(value) => {
            if (value === 'fab' || value === 'popover' || value === 'sidebar') {
              onLayoutModeChange(value);
            }
          }}
        >
          <DropdownMenuLabel>Chat layout</DropdownMenuLabel>
          <DropdownMenuRadioItem value="fab" className="gap-2">
            <CircleDot className="size-3.5 text-muted-foreground" />
            {CHAT_LAYOUT_MODE_LABELS.fab}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="popover" className="gap-2">
            <AppWindow className="size-3.5 text-muted-foreground" />
            {CHAT_LAYOUT_MODE_LABELS.popover}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="sidebar" className="gap-2">
            <PanelRight className="size-3.5 text-muted-foreground" />
            {CHAT_LAYOUT_MODE_LABELS.sidebar}
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ChatWorkingIndicator() {
  return (
    <div className="flex justify-start" aria-live="polite" aria-label="Agent is working">
      <div className="inline-flex items-center gap-1 rounded-lg bg-muted px-3 py-2.5 text-muted-foreground">
        <span className="size-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.3s]" />
        <span className="size-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.15s]" />
        <span className="size-1.5 animate-bounce rounded-full bg-current" />
      </div>
    </div>
  );
}

function MessageTimeIcon({
  label,
  className,
}: {
  label: string;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        type="button"
        className={cn(
          'inline-flex shrink-0 rounded-sm p-0.5 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
          className,
        )}
        aria-label={label}
      >
        <Clock className="size-3" aria-hidden />
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
