'use client';

/**
 * DM-1: the DM activity strip above the assistant agent chat. Hidden until the agent has DMs
 * (also when DMs could not be read); otherwise one quiet line, e.g. "3 DMs with CEO, CTO +1".
 *
 * DM-2: the strip only opens the conversation modal (dm-peek-dialog.tsx). It is a pure view now —
 * AgentChat owns the DM read and the modal, so the strip, the transcript chips and the modal all
 * read from the same client-side list.
 */
import * as React from 'react';
import { MessagesSquare } from 'lucide-react';
import { dmStripLabel, type DmStripSummary } from '@/lib/assistant/agent-dms';

/** Stateless strip; null (nothing rendered) without a summary. */
export function DmActivityStripView({ summary, onOpen }: { summary: DmStripSummary | null; onOpen: () => void }) {
  if (!summary) return null;
  const label = dmStripLabel(summary);
  return (
    <div className="min-w-0" data-dm-strip>
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
