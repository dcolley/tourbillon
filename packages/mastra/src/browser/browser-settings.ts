/**
 * Host settings for the opt-in `browser` toolset (local headless Chromium via Playwright).
 *
 * Env:
 * - TOURBILLON_BROWSER_EXECUTABLE_PATH — Chromium binary. Unset: Playwright's own
 *   download (`npx playwright install --with-deps chromium`, an Ops step).
 * - TOURBILLON_BROWSER_STEP_TIMEOUT_MS — hard cap per browser tool call (default 45000,
 *   clamped 5000–120000). On expiry the browser is closed and the step fails.
 * - TOURBILLON_BROWSER_NAV_TIMEOUT_MS — navigation / action timeout inside the page
 *   (default 30000, clamped 1000–step cap).
 */

export const BROWSER_EXECUTABLE_PATH_ENV = 'TOURBILLON_BROWSER_EXECUTABLE_PATH';
export const BROWSER_STEP_TIMEOUT_ENV = 'TOURBILLON_BROWSER_STEP_TIMEOUT_MS';
export const BROWSER_NAV_TIMEOUT_ENV = 'TOURBILLON_BROWSER_NAV_TIMEOUT_MS';

export const DEFAULT_BROWSER_STEP_TIMEOUT_MS = 45_000;
export const MIN_BROWSER_STEP_TIMEOUT_MS = 5_000;
export const MAX_BROWSER_STEP_TIMEOUT_MS = 120_000;
export const DEFAULT_BROWSER_NAV_TIMEOUT_MS = 30_000;
export const MIN_BROWSER_NAV_TIMEOUT_MS = 1_000;
/** Bound on browser.close() at run end so a wedged Chromium cannot hold the wake. */
export const BROWSER_CLOSE_TIMEOUT_MS = 10_000;

export interface BrowserSettings {
  executablePath?: string;
  stepTimeoutMs: number;
  navTimeoutMs: number;
}

function readInt(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) ? n : undefined;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function resolveBrowserSettings(env: NodeJS.ProcessEnv = process.env): BrowserSettings {
  const executablePath = env[BROWSER_EXECUTABLE_PATH_ENV]?.trim() || undefined;
  const stepTimeoutMs = clamp(
    readInt(env[BROWSER_STEP_TIMEOUT_ENV]) ?? DEFAULT_BROWSER_STEP_TIMEOUT_MS,
    MIN_BROWSER_STEP_TIMEOUT_MS,
    MAX_BROWSER_STEP_TIMEOUT_MS,
  );
  const navTimeoutMs = clamp(
    readInt(env[BROWSER_NAV_TIMEOUT_ENV]) ?? DEFAULT_BROWSER_NAV_TIMEOUT_MS,
    MIN_BROWSER_NAV_TIMEOUT_MS,
    stepTimeoutMs,
  );
  return { ...(executablePath ? { executablePath } : {}), stepTimeoutMs, navTimeoutMs };
}
