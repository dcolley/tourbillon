'use client';

/**
 * DM-2: the read-only conversation picker for an agent's DMs (A2A mail) — the DM-1 peek, split.
 * Left pane: one row per peer conversation (name, snippet, relative time, count, unread dot),
 * newest activity first. Right pane: the selected conversation, oldest message first. On narrow
 * screens the panes stack (list then thread, with a back control) — never an all-peers scroll.
 *
 * Still no composer and no send: DMs are sent by agents (sendToAgent), not from the assistant
 * view. Unread dots are client-only: a conversation counts as new while its last message is after
 * this device's last-seen mark (localStorage per agent+peer); opening its thread clears the dot.
 */
import * as React from 'react';
import { ArrowLeft } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ChatMarkdown } from '@/components/assistant/message-markdown';
import {
  AGENT_DMS_LIMIT,
  buildConversations,
  dmDirection,
  dmRelativeTime,
  dmSnippet,
  markDmSeen,
  readDmLastSeen,
  unreadPeerIds,
  type AgentDm,
  type DmConversationView,
  type DmStorageLike,
} from '@/lib/assistant/agent-dms';
import { cn } from '@/lib/utils';

function DmTime({ iso }: { iso: string }) {
  const d = new Date(iso);
  return <time dateTime={iso}>{Number.isNaN(d.getTime()) ? iso : d.toLocaleString()}</time>;
}

/** The peer's two initials (avatar stand-in — no avatar source in this slice). */
function peerInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  const words = trimmed.split(/\s+/);
  return words.length > 1 ? (words[0]![0]! + words[1]![0]!).toUpperCase() : trimmed.slice(0, 2).toUpperCase();
}

/**
 * Left pane: filter box + one row per peer conversation, newest activity first.
 * Stateless (state lives in DmConversationModal); tested with react-dom/server.
 */
export function DmConversationList({
  conversations,
  selectedPeerId,
  filter,
  onFilterChange,
  onSelect,
  unread,
}: {
  conversations: readonly DmConversationView[];
  selectedPeerId: string | null;
  filter: string;
  onFilterChange: (value: string) => void;
  onSelect: (peerId: string) => void;
  unread: readonly string[];
}) {
  const needle = filter.trim().toLowerCase();
  const shown = needle === '' ? [...conversations] : conversations.filter((conv) => conv.peerName.toLowerCase().includes(needle));
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-dm-list>
      <label className="block border-b p-2">
        <span className="sr-only">Filter by peer name</span>
        <input
          data-dm-filter
          type="search"
          aria-label="Filter by peer name"
          placeholder="Filter by peer"
          autoComplete="off"
          value={filter}
          onChange={(event) => onFilterChange(event.target.value)}
          className="h-7 w-full rounded-md border bg-transparent px-2 text-xs outline-none focus-visible:border-ring"
        />
      </label>
      {shown.length === 0 ? (
        <p className="px-3 py-3 text-xs text-muted-foreground" data-dm-filter-empty>
          No conversation matches that name.
        </p>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto py-1 text-xs" data-dm-conversation-rows>
          {shown.map((conv) => {
            const last = conv.messages[conv.messages.length - 1];
            return (
              <li key={conv.peerId}>
                <button
                  type="button"
                  data-dm-conversation={conv.peerId}
                  data-dm-selected={conv.peerId === selectedPeerId ? 'true' : undefined}
                  onClick={() => onSelect(conv.peerId)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted/60',
                    conv.peerId === selectedPeerId && 'bg-muted/60',
                  )}
                >
                  <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium">
                    {peerInitials(conv.peerName)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="truncate font-medium">{conv.peerName}</span>
                      <span className="shrink-0 text-muted-foreground">
                        {dmRelativeTime(conv.lastAt)} · {conv.count}
                      </span>
                    </span>
                    <span className="block truncate text-muted-foreground">{dmSnippet(last?.body ?? '')}</span>
                  </span>
                  {unread.includes(conv.peerId) ? (
                    <span data-dm-unread aria-label="Unread" className="size-1.5 shrink-0 self-center rounded-full bg-primary" />
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * Right pane: the selected conversation, oldest message first, direction by alignment + To/From
 * label, and a quoted reply reference that jumps to its parent when the parent is loaded.
 * Stateless; tested with react-dom/server.
 */
export function DmThreadPane({
  agentId,
  conversation,
  focusMessageId,
}: {
  agentId: string;
  conversation: DmConversationView | null;
  focusMessageId?: string | null;
}) {
  if (!conversation || conversation.messages.length === 0) {
    return (
      <p className="px-4 py-6 text-center text-sm text-muted-foreground" data-dm-empty>
        No DMs to show here yet.
      </p>
    );
  }
  const byId = new Map(conversation.messages.map((mail) => [mail.id, mail]));
  return (
    <ol className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3" data-dm-thread={conversation.peerId}>
      {conversation.messages.map((mail) => {
        const dir = dmDirection(mail, agentId);
        const self = dir === 'to';
        const peer = conversation.peerName;
        const parent = mail.inReplyTo ? byId.get(mail.inReplyTo) : undefined;
        return (
          <li
            key={mail.id}
            id={`dm-${mail.id}`}
            className={cn('space-y-1 rounded-md text-sm', self && 'text-right', mail.id === focusMessageId && 'bg-accent ring-1 ring-primary')}
            data-dm={mail.id}
            data-dm-direction={dir}
            data-dm-highlight={mail.id === focusMessageId ? 'true' : undefined}
          >
            <p className="flex items-baseline gap-2 text-xs text-muted-foreground" data-dm-header={mail.id}>
              <span className="font-medium">{self ? 'To' : 'From'}</span>
              <span>{peer}</span>
              <span aria-hidden>•</span>
              <DmTime iso={mail.createdAt} />
            </p>
            <ChatMarkdown text={mail.body} />
            {mail.inReplyTo ? (
              <p className="border-l-2 border-muted pl-2 text-xs text-muted-foreground" data-dm-reply>
                {'↩ reply to: '}
                {parent ? (
                  <a href={`#dm-${parent.id}`} data-dm-jump={parent.id} className="underline decoration-dotted underline-offset-2">
                    {dmSnippet(parent.body, 60)}
                  </a>
                ) : (
                  <>{mail.inReplyTo.slice(0, 8)}…</>
                )}
              </p>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The modal shell: conversation list (left / top) + thread pane (right / bottom).
 *
 * `key` is bumped per open by AgentChat, so the selection, the stacked-pane position and the
 * filter reset each time the dialog opens — and a chat reopened later still marks its history read.
 */
export function DmConversationModal({
  open,
  onOpenChange,
  agentId,
  agentName,
  mails,
  error,
  focus,
  storage,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentId: string;
  agentName?: string;
  mails: readonly AgentDm[];
  error?: string | null;
  /** Open preselected on this peer (from the strip or a chip), highlighting this message when given. */
  focus?: { peerId?: string; messageId?: string } | null;
  /** Client last-seen store (default: localStorage where available; null = dots off). */
  storage?: DmStorageLike | null;
}) {
  const conversations = React.useMemo(() => buildConversations(mails, agentId), [mails, agentId]);

  // Fresh state per mount (see `key`): start on the focused peer, else on the most recent conversation.
  const [selectedPeer, setSelectedPeer] = React.useState<string | null>(() => focus?.peerId ?? conversations[0]?.peerId ?? null);
  const [filter, setFilter] = React.useState('');
  const [view, setView] = React.useState<'list' | 'thread'>('thread');
  const selected = conversations.find((conv) => conv.peerId === selectedPeer) ?? conversations[0] ?? null;

  // Client-only unread (Derek's lock: last-seen per pair in localStorage, no server state). The map
  // is read when the modal opens (best-effort storage read, guarded in the helper); the selected
  // pair's dot hides while it is on screen (its body is being read), and opening a pair also marks
  // it read in storage — in the select handler, never during render.
  const lastSeen = React.useMemo(
    () => readDmLastSeen(storage, agentId, conversations.map((conv) => conv.peerId)),
    [storage, agentId, conversations],
  );
  const unread = React.useMemo(
    () => unreadPeerIds(conversations, lastSeen, selected && view === 'thread' ? [selected.peerId] : []),
    [conversations, lastSeen, selected, view],
  );

  const selectConversation = (peerId: string) => {
    markDmSeen(storage, agentId, peerId); // read-mark this pair (client-only, best-effort)
    setSelectedPeer(peerId);
    setView('thread');
  };

  // S1: the pair shown on open (focused peer, else the most recent) is being read too: mark it, as a
  // select does. After render (effect), best-effort; later picks are marked by the select handler.
  const shownPeerId = open && view === 'thread' ? selected?.peerId : undefined;
  React.useEffect(() => {
    if (shownPeerId) markDmSeen(storage, agentId, shownPeerId);
  }, [storage, agentId, shownPeerId]);

  const paneRef = React.useRef<HTMLElement | null>(null);
  React.useEffect(() => {
    if (view !== 'thread' || !focus?.messageId) return;
    paneRef.current?.querySelector(`[data-dm="${focus.messageId}"]`)?.scrollIntoView({ block: 'center' });
  }, [view, focus?.messageId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[85vh] max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(90vw,72rem)]"
        data-dm-dialog
        data-dm-conversation-picker
        data-dm-view={view}
      >
        <DialogHeader className="border-b px-4 py-3">
          <DialogTitle>{agentName ? `${agentName} · DMs` : 'DMs'}</DialogTitle>
          <DialogDescription>One conversation per peer, newest conversation first, oldest message first inside. Read-only.</DialogDescription>
        </DialogHeader>
        {conversations.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground" data-dm-empty>
            {error ? 'DMs could not be loaded.' : 'No DMs yet.'}
          </p>
        ) : (
          <div
            ref={paneRef as React.Ref<HTMLDivElement>}
            className="flex min-h-0 flex-1 flex-col overflow-hidden md:flex-row"
            data-dm-picker
          >
            <div
              className={cn(
                'w-full flex-col border-b md:flex md:w-56 md:shrink-0 md:border-b-0 md:border-r',
                view === 'list' ? 'flex' : 'hidden md:flex',
              )}
              data-dm-list-pane
            >
              <DmConversationList
                conversations={conversations}
                selectedPeerId={selected?.peerId ?? null}
                filter={filter}
                onFilterChange={setFilter}
                onSelect={selectConversation}
                unread={unread}
              />
            </div>
            <div
              className={cn('min-h-0 flex-1 flex-col', view === 'thread' ? 'flex' : 'hidden md:flex')}
              data-dm-thread-pane
            >
              <button
                type="button"
                onClick={() => setView('list')}
                className="flex items-center gap-1 border-b px-3 py-1.5 text-xs text-muted-foreground md:hidden"
                data-dm-back
              >
                <ArrowLeft className="size-3.5" aria-hidden /> All conversations
              </button>
              {mails.length >= AGENT_DMS_LIMIT ? (
                <p className="border-b px-3 py-1.5 text-xs text-muted-foreground" data-dm-capped>
                  Showing latest {AGENT_DMS_LIMIT} messages
                </p>
              ) : null}
              <DmThreadPane agentId={agentId} conversation={selected} focusMessageId={focus?.messageId ?? null} />
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
