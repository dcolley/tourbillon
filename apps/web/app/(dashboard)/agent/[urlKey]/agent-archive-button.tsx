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
import { archiveAgentAction } from '../archive-action';

/**
 * Board 'Archive agent' (Danger zone). Confirms first: archiving is permanent, stops the current
 * run and turns heartbeats off. Already archived → a read-only note instead of the button.
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

  if (status === 'archived') {
    return (
      <p className="text-sm text-muted-foreground">
        This agent is archived. Archiving is permanent: it can&apos;t be reactivated and its
        heartbeat timer is off.
      </p>
    );
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
      toast.success(result.changed ? `${agentName} archived.${runs}` : `${agentName} was already archived.`);
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
          Archiving is permanent. It stops the current run, turns off heartbeats and revokes the
          agent&apos;s run and chat tokens. History is kept.
        </p>
        <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
          Archive agent
        </Button>
      </div>
      <Dialog open={open} onOpenChange={(next) => !pending && setOpen(next)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Archive {agentName}?</DialogTitle>
            <DialogDescription>
              This is permanent: an archived agent can&apos;t be reactivated. Archiving stops the
              current run (if one is in progress) and turns off its heartbeats.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void confirmArchive()} disabled={pending}>
              {pending ? 'Archiving…' : 'Archive agent'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
