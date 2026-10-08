'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  ARCHIVE_PERMANENT_COPY,
  archiveImpactText,
  archiveResultText,
  type ArchiveImpact,
} from '@/lib/agent-archive-copy';
import { archiveAgentAction, getArchiveImpactAction } from '../archive-action';

export type ArchiveImpactState =
  | { state: 'loading' }
  | { state: 'error'; error: string }
  | ({ state: 'ready' } & ArchiveImpact);

/**
 * What archiving will change, shown in the confirm dialog before the board confirms:
 * 'N pending approvals will be rejected, M open issues unassigned'.
 */
export function ArchiveImpactSummary({ impact }: { impact: ArchiveImpactState }) {
  if (impact.state === 'loading') {
    return <p className="text-sm text-muted-foreground">Checking pending approvals and open issues…</p>;
  }
  if (impact.state === 'error') {
    return (
      <p className="text-sm text-destructive" role="alert">
        {impact.error} Close and try again.
      </p>
    );
  }
  return (
    <p className="text-sm font-medium" data-testid="archive-impact">
      {archiveImpactText(impact)}.
    </p>
  );
}

/**
 * Board 'Archive agent' (Danger zone). Confirms first, with the counts of what will change:
 * archiving is permanent (no unarchive), stops the current run, turns heartbeats off, rejects the
 * agent's pending approvals and unassigns its open issues. Already archived → a read-only note.
 */
export function AgentArchiveButton({
  agentId,
  agentName,
  urlKey,
  status,
}: {
  agentId: string;
  agentName: string;
  urlKey: string;
  status: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [impact, setImpact] = useState<ArchiveImpactState>({ state: 'loading' });

  if (status === 'archived') {
    return (
      <p className="text-sm text-muted-foreground">
        This agent is archived. Archiving is permanent: it can&apos;t be unarchived or reactivated,
        and its heartbeat timer is off.
      </p>
    );
  }

  async function openDialog() {
    setImpact({ state: 'loading' });
    setOpen(true);
    try {
      const result = await getArchiveImpactAction(agentId);
      setImpact(
        result.ok
          ? { state: 'ready', pendingApprovals: result.pendingApprovals, openIssues: result.openIssues }
          : { state: 'error', error: result.error },
      );
    } catch {
      setImpact({ state: 'error', error: 'Failed to load what archiving would change.' });
    }
  }

  async function confirmArchive() {
    setPending(true);
    try {
      const result = await archiveAgentAction(agentId, urlKey);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setOpen(false);
      const runs =
        result.runsStopped > 0
          ? ` Stopped ${result.runsStopped === 1 ? 'the current run' : `${result.runsStopped} runs`}.`
          : '';
      const changes = result.changed
        ? ` ${archiveResultText(result)}.`
        : '';
      toast.success(
        result.changed ? `${agentName} archived.${changes}${runs}` : `${agentName} was already archived.`,
      );
      router.refresh();
    } catch {
      toast.error('Failed to archive agent.');
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">
          Archiving is permanent: there is no unarchive. It stops the current run, turns off
          heartbeats, revokes the agent&apos;s run and chat tokens, rejects its pending approvals and
          unassigns its open issues. History is kept.
        </p>
        <Button type="button" variant="outline" size="sm" onClick={() => void openDialog()}>
          Archive agent
        </Button>
      </div>
      <Dialog open={open} onOpenChange={(next) => !pending && setOpen(next)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Archive {agentName}?</DialogTitle>
            <DialogDescription>
              {ARCHIVE_PERMANENT_COPY} Archiving stops the current run (if one is in progress) and
              turns off its heartbeats.
            </DialogDescription>
          </DialogHeader>
          <ArchiveImpactSummary impact={impact} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => void confirmArchive()}
              disabled={pending || impact.state !== 'ready'}
            >
              {pending ? 'Archiving…' : 'Archive agent'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
