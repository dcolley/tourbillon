import type { ProjectStatus } from '@/lib/projects';

export function parseProjectFilter(value: string | undefined): ProjectStatus | 'all' {
  if (value === 'paused' || value === 'completed' || value === 'archived' || value === 'all') {
    return value;
  }
  return 'active';
}
