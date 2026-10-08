'use client';

import { useEffect, useState } from 'react';
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
import { setAgentActiveAction } from '../actions';
import {
  agentChipLabel,
  isAgentChipActive,
  runOptimisticAgentToggle,
  shouldConfirmAgentToggle,
  type ChipInFlightHeartbeat,
} from './agent-active-chip-logic';

/**
 * UX-2: clickable Active/Inactive chip. Optimistic, rolls back with a toast on error, and asks
 * for confirmation only when deactivating while a heartbeat is running. Status only: the
 * heartbeat timer setting is untouched.
 */
export function AgentActiveChip({
  agentId,
  urlKey,
  initialStatus,
  inFlightHeartbeat,
}: {
  agentId: string;
  urlKey: string;
  initialStatus: string;
  inFlightHeartbeat: ChipInFlightHeartbeat;
}) {
  const router = useRouter();
  const [active, setActive] = useState(isAgentChipActive(initialStatus));
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, setPending] = useState(false);

  // Server render / router.refresh() is the source of truth (AC: after refresh the chip matches the DB).
  useEffect(() => {
    setActive(isAgentChipActive(initialStatus));
  }, [initialStatus]);

  // Plain async handler (not a transition) so the optimistic setActive renders immediately.
  async function apply(next: boolean) {
    setPending(true);
    try {
      const ok = await runOptimisticAgentToggle({
        current: active,
        next,
        apply: setActive,
        call: (value) => setAgentActiveAction(agentId, value, urlKey),
        onError: (message) => toast.error(message),
      });
      if (ok) router.refresh();
    } finally {
      setPending(false);
    }
  }

  function onClick() {
    if (pending) return;
    if (shouldConfirmAgentToggle(active, inFlightHeartbeat)) {
      setConfirmOpen(true);
      return;
    }
    void apply(!active);
  }

  return (
    <>
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        aria-pressed={active}
        aria-busy={pending || undefined}
        title={active ? 'Active. Click to make this agent inactive.' : 'Inactive. Click to make this agent active.'}
        className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 ${
          active ? 'bg-green-100 text-green-700 hover:bg-green-200' : 'bg-muted text-muted-foreground hover:bg-muted/70'
        }`}
      >
        {agentChipLabel(active)}
      </button>
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Make this agent inactive?</DialogTitle>
            <DialogDescription>
              A heartbeat is running for this agent. Making it inactive does not stop the heartbeat that is
              already running.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                setConfirmOpen(false);
                void apply(false);
              }}
            >
              Make inactive
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
