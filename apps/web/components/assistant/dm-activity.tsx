'use client';

/**
 * DM-1: DM activity strip at the top of the assistant agent chat. Hidden until the agent has a DM
 * (also when DMs cannot be read); otherwise one quiet line, e.g. "3 DMs with CEO, CTO +1", that
 * opens the read-only peek (dm-peek-dialog.tsx).
 */
import * as React from 'react';
import { MessagesSquare } from 'lucide-react';
import { dmStripLabel, dmStripSummary, groupDmsByPeer, type AgentDm, type DmStripSummary } from '@/lib/assistant/agent-dms';
import { DmPeekDialog } from './dm-peek-dialog';
import { useAgentDms } from './use-agent-dms';

/** Stateless strip; null (nothing rendered) without a summary. */
export function DmActivityStripView({ summary, onOpen }: { summary: DmStripSummary | null; onOpen: () => void }) {
  if (!summary) return null;
  const label = dmStripLabel(summary);
  return (
    <div className="border-b px-4 py-1.5" data-dm-strip>
      <button
        type="button"
        onClick={onOpen}
        className="flex max-w-full items-center gap-1.5 truncate text-xs text-muted-foreground hover:text-foreground"
        aria-label={`${label} — view DMs`}
        aria-haspopup="dialog"
      >
        <MessagesSquare className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate">{label}</span>
      </button>
    </div>
  );
}

/** Strip + peek for already-loaded DMs (stateless apart from the dialog's open state). */
export function DmActivity({ agentId, mails, error }: { agentId: string; mails: readonly AgentDm[]; error?: string | null }) {
  const [open, setOpen] = React.useState(false);
  const summary = dmStripSummary(groupDmsByPeer(mails, agentId));
  if (!summary) return null;
  return (
    <>
      <DmActivityStripView summary={summary} onOpen={() => setOpen(true)} />
      <DmPeekDialog open={open} onOpenChange={setOpen} agentId={agentId} mails={mails} error={error} />
    </>
  );
}

/** The agent's DMs through the board session, polled while the page is visible. */
export function AgentDmActivity({ companyId, agentId }: { companyId: string; agentId: string }) {
  const dms = useAgentDms(companyId, agentId);
  return <DmActivity agentId={agentId} mails={dms.mails} error={dms.error} />;
}
