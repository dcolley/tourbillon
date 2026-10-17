import type { AgentRuntimeConfig } from './types';

export const BROWSER_TOOLSET = 'browser';

/** Never exposed, whatever the config says: runs arbitrary script in the page. */
export const BROWSER_ALWAYS_EXCLUDED_TOOLS = ['browser_evaluate'] as const;
/** Opt-in per agent via runtimeConfig.browser.screenshots (default off). */
export const BROWSER_SCREENSHOT_TOOL = 'browser_screenshot';

/** True only when the agent explicitly opted in to browser_screenshot. */
export function isBrowserScreenshotsEnabled(
  runtime?: Pick<AgentRuntimeConfig, 'browser'> | null,
): boolean {
  return runtime?.browser?.screenshots === true;
}

/** Tools to drop from the browser provider's toolset for this agent. */
export function browserExcludedTools(
  runtime?: Pick<AgentRuntimeConfig, 'browser'> | null,
): string[] {
  return [
    ...BROWSER_ALWAYS_EXCLUDED_TOOLS,
    ...(isBrowserScreenshotsEnabled(runtime) ? [] : [BROWSER_SCREENSHOT_TOOL]),
  ];
}

/**
 * Capabilities writer rule (same shape as knowledgeGraph): with the toolset on, store the
 * submitted sub-options; with it off, clear them. When the caller sends no browser input
 * (e.g. a writer without the field), keep what is stored while the toolset stays on.
 */
export function nextBrowserRuntimeConfig(
  current: AgentRuntimeConfig['browser'] | undefined,
  toolsets: readonly string[],
  input: { screenshots: boolean } | undefined,
): AgentRuntimeConfig['browser'] | undefined {
  if (!toolsets.includes(BROWSER_TOOLSET)) return undefined;
  if (input === undefined) return current;
  return { screenshots: input.screenshots === true };
}
