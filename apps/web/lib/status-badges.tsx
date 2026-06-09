import { Badge } from '@/components/ui/badge';
import type { VariantProps } from 'class-variance-authority';
import { badgeVariants } from '@/components/ui/badge';

type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>['variant']>;

const STATUS_VARIANTS: Record<string, BadgeVariant> = {
  succeeded: 'default',
  completed: 'default',
  approved: 'default',
  active: 'default',
  failed: 'destructive',
  rejected: 'destructive',
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
};

export function StatusBadge({ status }: { status: string }) {
  const normalized = status.toLowerCase().replace(/\s+/g, '_');
  const variant = STATUS_VARIANTS[normalized] ?? 'outline';

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
