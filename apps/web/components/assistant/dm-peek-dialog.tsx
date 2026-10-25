'use client';

/**
 * DM-1: read-only peek at an agent's DMs (A2A mail), grouped by the other agent. No composer and
 * no send: DMs are sent by agents (sendToAgent), not from the assistant view.
 */
import * as React from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ChatMarkdown } from '@/components/assistant/message-markdown';
import { dmDirection, groupDmsByPeer, type AgentDm } from '@/lib/assistant/agent-dms';

function DmTime({ iso }: { iso: string }) {
  const d = new Date(iso);
  return <time dateTime={iso}>{Number.isNaN(d.getTime()) ? iso : d.toLocaleString()}</time>;
}

/** The grouped list (stateless; tested with react-dom/server). */
export function DmPeekList({ agentId, mails, error }: { agentId: string; mails: readonly AgentDm[]; error?: string | null }) {
  const conversations = groupDmsByPeer(mails, agentId);
  if (conversations.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-muted-foreground" data-dm-empty>
        {error ? 'DMs could not be loaded.' : 'No DMs yet.'}
      </p>
    );
  }
  return (
    <div className="space-y-4" data-dm-list>
      {error ? (
        <p className="text-xs text-muted-foreground" data-dm-stale>
          Could not refresh — showing the last DMs loaded.
        </p>
      ) : null}
      {conversations.map((conv) => (
        <section key={conv.peerId} className="space-y-2" data-dm-peer={conv.peerId}>
          <h3 className="text-xs font-semibold text-muted-foreground">
            {conv.peerName} <span className="font-normal">· {conv.mails.length}</span>
          </h3>
          <ol className="space-y-2">
            {conv.mails.map((mail) => {
              const dir = dmDirection(mail, agentId);
              return (
                <li key={mail.id} className="rounded-md border p-2" data-dm={mail.id} data-dm-direction={dir}>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="font-medium">{dir === 'to' ? 'To' : 'From'}</span>
                    <span>{conv.peerName}</span>
                    <span aria-hidden>•</span>
                    <DmTime iso={mail.createdAt} />
                  </div>
                  <div className="mt-1 text-sm">
                    <ChatMarkdown text={mail.body} />
                  </div>
                  {mail.inReplyTo ? (
                    <p className="mt-1 text-xs text-muted-foreground" data-dm-reply>
                      ↳ In reply to {mail.inReplyTo.slice(0, 8)}…
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}

export function DmPeekDialog({
  open,
  onOpenChange,
  agentId,
  agentName,
  mails,
  error,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentId: string;
  agentName?: string;
  mails: readonly AgentDm[];
  error?: string | null;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-2xl flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl" data-dm-dialog>
        <DialogHeader className="border-b px-4 py-3">
          <DialogTitle>{agentName ? `${agentName} · DMs` : 'DMs'}</DialogTitle>
          <DialogDescription>Sent and received, most recent first. Read-only.</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <DmPeekList agentId={agentId} mails={mails} error={error} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
