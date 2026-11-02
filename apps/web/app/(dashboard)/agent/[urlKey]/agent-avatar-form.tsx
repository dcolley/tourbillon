'use client';

/**
 * AGENT-AVATAR-UI: the agent page's Avatar control (Derek's Grok-Bot modal reference, v1 =
 * shape + colour only — the Generate / Upload tabs are follow-ups, see the PR).
 *
 * An organic-shapes grid + a colour row, a live preview, `Reset to default`, and `Done` (saves
 * via the page's server action). Closing without Done dismisses without saving — the selection
 * lives in local state only.
 */
import { useActionState, useState } from 'react';
import {
  AGENT_AVATAR_PALETTE,
  AGENT_AVATAR_SHAPE_IDS,
  type AgentAvatarConfig,
  type AgentAvatarShapeId,
} from '@tourbillon/shared/agent-avatar';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { AgentAvatar, AgentColorSwatch, AgentShapeGlyph } from '@/components/assistant/agent-avatar';
import { useActionToast } from '@/hooks/use-action-toast';
import type { ActionResult } from '@/lib/action-result';

export type UpdateAvatarAction = (prev: ActionResult | null, formData: FormData) => Promise<ActionResult>;

export function AgentAvatarSection({
  agentId,
  urlKey,
  agentName,
  initial,
  updateAvatar,
}: {
  agentId: string;
  urlKey: string;
  agentName: string;
  initial: AgentAvatarConfig | null;
  updateAvatar: UpdateAvatarAction;
}) {
  const [state, formAction, isPending] = useActionState(updateAvatar, null);
  const [open, setOpen] = useState(false);
  // The modal edits a local selection; Done submits it, closing the dialog keeps the saved value.
  const [shape, setShape] = useState<AgentAvatarShapeId | null>(initial?.shape ?? null);
  const [color, setColor] = useState<string | null>(initial?.color ?? null);

  const selection: AgentAvatarConfig | null = shape && color ? { shape, color } : null;
  // Colour the shape grid previews with (the row's current pick, else the palette default).
  const gridColor = color ?? AGENT_AVATAR_PALETTE[0].hex;
  useActionToast(state); // toast + router.refresh() so the saved preview comes back from the server
  const busy = isPending;

  return (
    <section className="border rounded-lg p-4 space-y-4" data-agent-avatar-section>
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold">Avatar</h2>
          <p className="text-xs text-muted-foreground mt-1">
            Pick a blob shape and colour for this agent (sidebar, agent list and chat header).
            AI Generate and Upload are coming in later releases.
          </p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <AgentAvatar name={agentName} config={initial} size="header" defaultClassName="bg-primary/10 text-primary" />
          <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
            Edit avatar
          </Button>
        </div>
      </div>

      <Dialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Avatar</DialogTitle>
            <DialogDescription>Shape and colour. Done saves; closing without Done discards the choice.</DialogDescription>
          </DialogHeader>

          <div className="flex items-center gap-4" data-avatar-preview>
            <AgentAvatar name={agentName} config={selection} size="preview" />
            <p className="text-xs text-muted-foreground">
              {selection ? `${selection.shape} · ${selection.color}` : 'Default avatar (initials circle)'}
            </p>
          </div>

          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Shape</h3>
            <div className="flex flex-wrap gap-2" data-avatar-shapes>
              {AGENT_AVATAR_SHAPE_IDS.map((id) => (
                <AgentShapeGlyph
                  key={id}
                  shape={id}
                  color={gridColor}
                  selected={shape === id}
                  onSelect={() => setShape(id)}
                />
              ))}
            </div>
          </div>

          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Colour</h3>
            <div className="flex flex-wrap gap-2" data-avatar-colors>
              {AGENT_AVATAR_PALETTE.map((c) => (
                <AgentColorSwatch
                  key={c.id}
                  id={c.id}
                  hex={c.hex}
                  label={c.label}
                  selected={color === c.hex}
                  onSelect={() => setColor(c.hex)}
                />
              ))}
            </div>
          </div>

          <form action={formAction}>
            <input type="hidden" name="agentId" value={agentId} />
            <input type="hidden" name="urlKey" value={urlKey} />
            <input type="hidden" name="shape" value={shape ?? ''} />
            <input type="hidden" name="color" value={color ?? ''} />
            <DialogFooter className="mt-4 gap-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  setShape(null);
                  setColor(null);
                }}
              >
                Reset to default
              </Button>
              <div className="flex-1" />
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={busy} data-avatar-done>
                Done
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
