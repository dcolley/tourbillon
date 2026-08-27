'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { triggerAgentHeartbeatAction, forceKillHeartbeatAction } from '../actions';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { MoreVertical } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export type InFlightHeartbeat = {
  id: string;
  status: 'queued' | 'running';
};

export function AgentHeartbeatHeaderActions({
  agentId,
  companyId,
  urlKey,
  canRunHeartbeat,
  initialInFlight,
}: {
  agentId: string;
  companyId: string;
  urlKey: string;
  agentName: string;
  canRunHeartbeat: boolean;
  initialInFlight: InFlightHeartbeat | null;
}) {
  const [inFlight, setInFlight] = useState<InFlightHeartbeat | null>(initialInFlight);
  const [showKillDialog, setShowKillDialog] = useState(false);

  useEffect(() => {
    setInFlight(initialInFlight);
  }, [initialInFlight]);

  useEffect(() => {
    if (!inFlight) return;

    const runId = inFlight.id;
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/jobs/heartbeat/${runId}/live`);
        if (!res.ok) return;

        const data = (await res.json()) as {
          heartbeatRun?: { status?: string } | null;
        };
        const status = data.heartbeatRun?.status;
        if (status === 'queued' || status === 'running') {
          setInFlight({ id: runId, status });
          return;
        }
        setInFlight(null);
      } catch {
        // ignore transient fetch errors while polling
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [inFlight?.id]);

  const runDisabled = !canRunHeartbeat || inFlight != null;
  const runTitle = inFlight
    ? 'A heartbeat is already queued or running'
    : !canRunHeartbeat
      ? 'Agent must be active and within budget'
      : 'Queue an on-demand heartbeat for this agent';

  return (
    <>
      {inFlight && (
        <Button variant="outline" size="sm" render={<Link href={`/heartbeat/${inFlight.id}`} />}>
          {inFlight.status === 'queued' ? 'View queued heartbeat' : 'View running heartbeat'}
        </Button>
      )}
      <form action={triggerAgentHeartbeatAction}>
        <input type="hidden" name="agentId" value={agentId} />
        <input type="hidden" name="companyId" value={companyId} />
        <input type="hidden" name="urlKey" value={urlKey} />
        <Button type="submit" size="sm" disabled={runDisabled} title={runTitle}>
          Run heartbeat
        </Button>
      </form>
      {inFlight && (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="ghost" size="sm" className="h-8 w-8 p-0" />}
          >
            <span className="sr-only">Open menu</span>
            <MoreVertical className="h-4 w-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => setShowKillDialog(true)}
            >
              Force-kill heartbeat
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <Dialog open={showKillDialog} onOpenChange={setShowKillDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Force-kill heartbeat</DialogTitle>
            <DialogDescription>
              This stops the wake and releases any checkout lock. The heartbeat will be marked as failed.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowKillDialog(false)}>
              Cancel
            </Button>
            <form action={forceKillHeartbeatAction}>
              <input type="hidden" name="runId" value={inFlight?.id ?? ''} />
              <input type="hidden" name="companyId" value={companyId} />
              <input type="hidden" name="returnPath" value={`/agent/${urlKey}`} />
              <Button type="submit" variant="destructive">
                Force-kill
              </Button>
            </form>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
