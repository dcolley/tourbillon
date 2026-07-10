'use client';

import type { BuildInfo } from '@/lib/build-info';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

function formatBuiltAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function SidebarBuildInfo({ buildInfo }: { buildInfo: BuildInfo }) {
  const envLabel =
    buildInfo.environment === 'production' ? null : buildInfo.environment;

  const detail = [
    `commit ${buildInfo.commit}`,
    envLabel,
    buildInfo.builtAt ? `built ${formatBuiltAt(buildInfo.builtAt)}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="px-2 py-1.5 group-data-[collapsible=icon]:hidden">
      <Tooltip>
        <TooltipTrigger className="block w-full min-w-0 cursor-default select-none text-left outline-none">
          <p className="truncate text-xs font-medium text-muted-foreground">
            v{buildInfo.version}
          </p>
          <p className="truncate text-[10px] leading-tight text-muted-foreground/80">
            {buildInfo.commit}
            {envLabel ? ` · ${envLabel}` : null}
          </p>
        </TooltipTrigger>
        <TooltipContent side="right" align="end">
          <p className="font-medium">Tourbillon v{buildInfo.version}</p>
          <p className="text-muted-foreground">{detail}</p>
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
