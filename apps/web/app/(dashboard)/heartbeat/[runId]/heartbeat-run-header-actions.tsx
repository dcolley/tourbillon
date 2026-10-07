'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  forceKillHeartbeatAction,
  retryFailedHeartbeatAction,
} from '../../agent/actions';
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
import {
  canForceKillHeartbeat,
  canRetryFailedHeartbeat,
} from '@tourbillon/shared/heartbeat-liveness';

export function HeartbeatRunHeaderActions({
  runId,
  companyId,
  status,
}: {
  runId: string;
  companyId: string;
  status: string;
}) {
  const [showKillDialog, setShowKillDialog] = useState(false);

  // Failed runs offer "Retry in new heartbeat" (new runId; failed row stays immutable).
  if (canRetryFailedHeartbeat(status)) {
    return (
      <form action={retryFailedHeartbeatAction}>
        <input type="hidden" name="runId" value={runId} />
        <input type="hidden" name="companyId" value={companyId} />
        <Button type="submit" variant="outline" size="sm">
          Retry in new heartbeat
        </Button>
      </form>
    );
  }

  if (!canForceKillHeartbeat(status)) {
    return null;
  }

  return (
    <>
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
      <Dialog open={showKillDialog} onOpenChange={setShowKillDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Force-kill heartbeat</DialogTitle>
            <DialogDescription>
              This stops the wake and releases any checkout lock.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowKillDialog(false)}>
              Cancel
            </Button>
            <form action={forceKillHeartbeatAction}>
              <input type="hidden" name="runId" value={runId} />
              <input type="hidden" name="companyId" value={companyId} />
              <input type="hidden" name="returnPath" value={`/heartbeat/${runId}`} />
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
