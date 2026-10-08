import type { CompanySettings } from '../types';
import {
  WAKE_COMMENTS_MAX_CHARS,
  WAKE_HEADER_MAX_CHARS,
  WAKE_TOTAL_SOFT_MAX_CHARS,
} from './constants';
import type { WakeContextBudgets } from './types';

export const DEFAULT_WAKE_CONTEXT_BUDGETS: WakeContextBudgets = {
  headerMaxChars: WAKE_HEADER_MAX_CHARS,
  commentsMaxChars: WAKE_COMMENTS_MAX_CHARS,
  totalSoftMaxChars: WAKE_TOTAL_SOFT_MAX_CHARS,
};

/** Env switch for deployments: `TOURBILLON_WAKE_CONTEXT_V2=1|0` (company setting wins). */
export const WAKE_CONTEXT_V2_ENV = 'TOURBILLON_WAKE_CONTEXT_V2';

function envFlag(raw: string | undefined): boolean | undefined {
  const v = raw?.trim().toLowerCase();
  if (!v) return undefined;
  if (['1', 'true', 'on', 'yes'].includes(v)) return true;
  if (['0', 'false', 'off', 'no'].includes(v)) return false;
  return undefined;
}

const clampInt = (v: number | undefined, lo: number, hi: number, dflt: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : dflt;

/**
 * WC6: is the live wake context (header + compaction, "v2") on, and with which budgets?
 * Order: company setting `wakeContextV2` → env `TOURBILLON_WAKE_CONTEXT_V2` → off.
 * When off, wakes still get the newest-first fill (T1); the old oldest-first fill is gone.
 */
export function resolveWakeContextConfig(
  settings?: CompanySettings | null,
  env: Record<string, string | undefined> = process.env,
): { enabled: boolean; source: 'company' | 'env' | 'default'; budgets: WakeContextBudgets } {
  const company = settings?.wakeContextV2;
  const fromEnv = envFlag(env[WAKE_CONTEXT_V2_ENV]);
  const enabled = typeof company === 'boolean' ? company : fromEnv ?? false;
  const source = typeof company === 'boolean' ? 'company' : fromEnv !== undefined ? 'env' : 'default';
  const o = settings?.wakeContextBudgets;
  return {
    enabled,
    source,
    budgets: {
      headerMaxChars: clampInt(o?.headerMaxChars, 600, 8000, WAKE_HEADER_MAX_CHARS),
      commentsMaxChars: clampInt(o?.commentsMaxChars, 1000, 20000, WAKE_COMMENTS_MAX_CHARS),
      totalSoftMaxChars: clampInt(o?.totalSoftMaxChars, 2000, 40000, WAKE_TOTAL_SOFT_MAX_CHARS),
    },
  };
}
