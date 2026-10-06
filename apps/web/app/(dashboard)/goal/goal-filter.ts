import type { GoalStatus } from '@/lib/goals';

export function parseGoalFilter(value: string | undefined): GoalStatus | 'all' {
  if (value === 'completed' || value === 'archived' || value === 'all') return value;
  return 'active';
}
