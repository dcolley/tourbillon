/**
 * Gate for the opt-in `browser` toolset. Kept free of heavy imports: the browser
 * provider (@mastra/agent-browser → playwright-core) is only loaded when an agent has
 * the toolset, so agents without it never construct or import a browser.
 */
import { createTraceLogger } from '@tourbillon/shared';
import { readBrowserHostAllowList, type BrowserEgressPolicy } from './browser-egress';
import { resolveBrowserSettings, BROWSER_CLOSE_TIMEOUT_MS } from './browser-settings';
import type { MastraBrowser } from '@mastra/core/browser';

export const BROWSER_TOOLSET_ID = 'browser';

export interface BrowserAgentRecordLike {
  id: string;
  companyId?: string | null;
  assignedToolsets?: string[] | null;
  runtimeConfig?: unknown;
}

export function agentHasBrowserToolset(agentRecord: Pick<BrowserAgentRecordLike, 'assignedToolsets'>): boolean {
  return agentRecord.assignedToolsets?.includes(BROWSER_TOOLSET_ID) ?? false;
}

type BrowserModule = typeof import('./tourbillon-agent-browser');
export type BrowserModuleLoader = () => Promise<Pick<BrowserModule, 'TourbillonAgentBrowser'>>;

const defaultLoader: BrowserModuleLoader = () => import('./tourbillon-agent-browser');

/**
 * Build the Mastra browser for an agent, or undefined when the toolset is off (or the
 * host is configured to hand the browser to a cloud provider, which would bypass the
 * egress guard). Never launches Chromium — launch is lazy on the first browser tool call.
 */
export async function buildAgentBrowser(
  agentRecord: BrowserAgentRecordLike,
  options?: {
    companySettings?: unknown;
    env?: NodeJS.ProcessEnv;
    loader?: BrowserModuleLoader;
    resolve?: BrowserEgressPolicy['resolve'];
  },
): Promise<MastraBrowser | undefined> {
  if (!agentHasBrowserToolset(agentRecord)) return undefined;
  const env = options?.env ?? process.env;
  const trace = createTraceLogger('browser', {
    agentId: agentRecord.id,
    ...(agentRecord.companyId ? { companyId: agentRecord.companyId } : {}),
  });
  if (env.AGENT_BROWSER_PROVIDER?.trim()) {
    trace.warn('browser toolset omitted: AGENT_BROWSER_PROVIDER is set (cloud browsers bypass the egress guard)');
    return undefined;
  }
  const settings = resolveBrowserSettings(env);
  const policy: BrowserEgressPolicy = {
    hostAllowList: readBrowserHostAllowList(options?.companySettings, agentRecord.runtimeConfig),
    ...(options?.resolve ? { resolve: options.resolve } : {}),
  };
  const { TourbillonAgentBrowser } = await (options?.loader ?? defaultLoader)();
  return new TourbillonAgentBrowser({
    settings,
    policy,
    agentId: agentRecord.id,
    ...(agentRecord.companyId ? { companyId: agentRecord.companyId } : {}),
  }) as unknown as MastraBrowser;
}

/**
 * Close the browser attached to an Agent / DurableAgent at run end. Bounded and
 * best-effort: never throws, never masks the run's own error.
 */
export async function closeAgentBrowser(
  ...agents: Array<{ browser?: unknown } | undefined | null>
): Promise<void> {
  for (const agent of agents) {
    let browser: unknown;
    try {
      browser = agent?.browser;
    } catch {
      continue;
    }
    if (!browser || typeof browser !== 'object') continue;
    const b = browser as { closeQuietly?: (reason: string) => Promise<void>; close?: () => Promise<void> };
    try {
      if (typeof b.closeQuietly === 'function') {
        await b.closeQuietly('run_end');
      } else if (typeof b.close === 'function') {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          b.close(),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, BROWSER_CLOSE_TIMEOUT_MS);
          }),
        ]).finally(() => timer && clearTimeout(timer));
      }
    } catch {
      /* best-effort teardown */
    }
  }
}

export { resolveBrowserSettings } from './browser-settings';
export {
  BROWSER_EXECUTABLE_PATH_ENV,
  BROWSER_NAV_TIMEOUT_ENV,
  BROWSER_STEP_TIMEOUT_ENV,
} from './browser-settings';
