import { Badge } from '@/components/ui/badge';
import type { VariantProps } from 'class-variance-authority';
import { badgeVariants } from '@/components/ui/badge';

type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>['variant']>;

const STATUS_VARIANTS: Record<string, BadgeVariant> = {
  succeeded: 'default',
  completed: 'default',
  approved: 'default',
  answered: 'default',
  active: 'default',
  failed: 'destructive',
  rejected: 'destructive',
  declined: 'secondary',
  expired: 'ghost',
  error: 'destructive',
  running: 'secondary',
  in_progress: 'secondary',
  processing: 'secondary',
  queued: 'outline',
  pending: 'outline',
  open: 'outline',
  cancelled: 'outline',
  paused: 'ghost',
  waiting: 'outline',
  delayed: 'outline',
  archived: 'ghost',
  pending_approval: 'secondary',
  done: 'default',
  // #295: a skipped wake (e.g. assignee-mismatch task wake) is a neutral terminal
  // state — same muted treatment as paused/expired, never the destructive colour.
  skipped: 'ghost',
};

/** Resolved separately so the status→variant table is testable without React. */
export function statusBadgeVariant(status: string): BadgeVariant {
  const normalized = status.toLowerCase().replace(/\s+/g, '_');
  return STATUS_VARIANTS[normalized] ?? 'outline';
}

export function StatusBadge({ status }: { status: string }) {
  const variant = statusBadgeVariant(status);

  return <Badge variant={variant}>{status.replace(/_/g, ' ')}</Badge>;
}

const PRIORITY_VARIANTS: Record<string, BadgeVariant> = {
  critical: 'destructive',
  high: 'secondary',
  medium: 'outline',
  low: 'ghost',
};

export function PriorityBadge({ priority }: { priority: string }) {
  const variant = PRIORITY_VARIANTS[priority] ?? 'outline';
  return <Badge variant={variant} className="capitalize">{priority}</Badge>;
}
