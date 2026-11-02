import { Badge } from '@/components/ui/badge';
import type { QueueCounts } from '@/lib/jobs';

/**
 * S298-S3 (#298): the /jobs queue card used to render `skipped: 0` for every queue,
 * including queues that can never produce task-scoped skips. Rule chosen (the simple
 * one, per the brief): the neutral terminal counters — skipped / coalesced / cancelled
 * — hide themselves at 0; the core operational counters (waiting, active, completed,
 * failed) always render, because 0 is itself the signal there.
 *
 * Rendered by page.tsx (server component). The render test drives THIS component
 * directly with renderToStaticMarkup so the hide rule is observable (a mutant that
 * always renders zero counts goes RED here).
 */
const ZERO_HIDABLE_COUNTERS: readonly string[] = ['skipped', 'coalesced', 'cancelled'];

/** Pure visibility rule — exported for tests and as the single decision point. */
export function shouldRenderCountBadge(label: string, value: number): boolean {
  if (value === 0 && ZERO_HIDABLE_COUNTERS.includes(label)) return false;
  return true;
}

export function QueueCountBadges({ counts }: { counts: QueueCounts }) {
  return (
    <div className="flex flex-wrap gap-2">
      <CountBadge label="waiting" value={counts.waiting} />
      <CountBadge label="active" value={counts.active} />
      <CountBadge label="failed" value={counts.failed} highlight={counts.failed > 0} />
      <CountBadge label="completed" value={counts.completed} />
      {/* #295/#298: neutral terminal states — never highlighted as failure, hidden at 0. */}
      <CountBadge label="skipped" value={counts.skipped} />
      <CountBadge label="coalesced" value={counts.coalesced} />
      <CountBadge label="cancelled" value={counts.cancelled} />
    </div>
  );
}

function CountBadge({
  label,
  value,
  highlight,
}: {
  label: string;
  value: number;
  highlight?: boolean;
}) {
  if (!shouldRenderCountBadge(label, value)) return null;
  return (
    <Badge variant={highlight ? 'destructive' : 'secondary'}>
      {label}: {value}
    </Badge>
  );
}
