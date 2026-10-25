'use client';

/**
 * ASYNC-0 (Slice A): the agent chat ⋯ menu. Clear chat (after a confirm) starts a fresh
 * conversation; Observational Memory opens the agent's OM settings in the Control Pane.
 * There is no New chat and no thread list: each agent has one conversation in the assistant view.
 */
import * as React from 'react';
import { MoreHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { agentChatMenuItems, type ClearChatResult } from '@/lib/assistant/single-chat';

/** Confirm body (stateless; tested with react-dom/server). */
export function ClearChatConfirmView({
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex flex-col gap-3" data-clear-chat-confirm>
      <p className="text-sm text-muted-foreground">
        This starts a fresh conversation with the agent. The current conversation will no longer be shown here.
      </p>
      {error ? (
        <p role="alert" className="text-sm text-destructive" data-clear-chat-error>
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="outline" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button type="button" size="sm" variant="destructive" onClick={onConfirm} disabled={busy}>
          {busy ? 'Clearing…' : 'Clear chat'}
        </Button>
      </div>
    </div>
  );
}

export function AgentChatMenu({
  agentUrlKey,
  runOpen,
  onClear,
}: {
  agentUrlKey: string;
  runOpen: boolean;
  onClear: () => Promise<ClearChatResult>;
}) {
  const [confirming, setConfirming] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const items = agentChatMenuItems({ agentUrlKey, runOpen, clearing: busy });
  const confirm = () => {
    setBusy(true);
    setError(null);
    void onClear().then((r) => {
      setBusy(false);
      if (r.ok) setConfirming(false);
      else setError(r.error);
    });
  };
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button type="button" variant="ghost" size="icon-xs" aria-label="Chat options" data-chat-menu />}>
          <MoreHorizontal />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          {items.map((item) =>
            item.href ? (
              <DropdownMenuItem key={item.id} data-chat-menu-item={item.id} render={<a href={item.href} />}>
                {item.label}
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem
                key={item.id}
                data-chat-menu-item={item.id}
                disabled={item.disabled}
                title={item.hint}
                onClick={() => {
                  setError(null);
                  setConfirming(true);
                }}
              >
                {item.label}
              </DropdownMenuItem>
            ),
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={confirming} onOpenChange={(open) => !busy && setConfirming(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Clear chat?</DialogTitle>
            <DialogDescription className="sr-only">Start a fresh conversation with this agent.</DialogDescription>
          </DialogHeader>
          <ClearChatConfirmView busy={busy} error={error} onConfirm={confirm} onCancel={() => setConfirming(false)} />
        </DialogContent>
      </Dialog>
    </>
  );
}
