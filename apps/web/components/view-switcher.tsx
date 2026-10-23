'use client';

import { useRouter } from 'next/navigation';
import { Bot, LayoutDashboard } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  APP_VIEWS,
  APP_VIEW_LABELS,
  viewHomePath,
  writeViewPreference,
  type AppView,
} from '@/lib/view-preference';

const VIEW_ICONS: Record<AppView, LucideIcon> = {
  assistant: Bot,
  control: LayoutDashboard,
};

/**
 * Choosing a view stores it (so `/` lands there next time) and navigates to its landing page.
 * Choosing the current view does nothing.
 */
export function selectAppView(
  view: AppView,
  current: AppView,
  deps: { write: (view: AppView) => void; navigate: (path: string) => void },
): void {
  if (view === current) return;
  deps.write(view);
  deps.navigate(viewHomePath(view));
}

/** Stateless segmented control: Assistant | Control Pane. */
export function ViewSwitcherView({
  current,
  onSelect,
  className,
}: {
  current: AppView;
  onSelect: (view: AppView) => void;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label="View"
      className={cn('inline-flex shrink-0 items-center rounded-md border bg-muted/40 p-0.5', className)}
    >
      {APP_VIEWS.map((view) => {
        const active = view === current;
        const Icon = VIEW_ICONS[view];
        return (
          <button
            key={view}
            type="button"
            aria-pressed={active}
            data-view={view}
            onClick={() => onSelect(view)}
            className={cn(
              'inline-flex h-7 items-center gap-1.5 rounded-sm px-2.5 text-xs font-medium transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              active
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon className="size-3.5" aria-hidden />
            <span>{APP_VIEW_LABELS[view]}</span>
          </button>
        );
      })}
    </div>
  );
}

/** View switcher for the shells' top bars. */
export function ViewSwitcher({ current, className }: { current: AppView; className?: string }) {
  const router = useRouter();
  return (
    <ViewSwitcherView
      current={current}
      className={className}
      onSelect={(view) =>
        selectAppView(view, current, { write: writeViewPreference, navigate: (p) => router.push(p) })
      }
    />
  );
}
