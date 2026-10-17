/**
 * TourbillonAgentBrowser — @mastra/agent-browser with Tourbillon guard rails:
 *
 * - Egress: a Playwright context route checks every http(s) request (navigations,
 *   subresources, popups, new tabs) with {@link checkBrowserUrl}. The route fetches each
 *   request itself without following redirects, checks every Location, follows allowed
 *   hops itself (up to {@link BROWSER_MAX_REDIRECT_HOPS}) and hands the browser only the
 *   final response, so the browser never follows a redirect on its own. WebSockets are
 *   checked too. `browser_goto` / `browser_tabs` URLs are checked before the browser is
 *   even launched, so file:// and other schemes never reach Chromium.
 * - Session restore: when a thread's browser is relaunched, the guard is installed on
 *   the new context before any saved tab is reopened, and each saved tab URL is checked
 *   again; refused tabs are dropped.
 * - Timeouts: navigation / action timeouts are capped in the page, and every browser
 *   tool call is raced against a hard step cap. A step that hits the cap (or is aborted)
 *   closes the browser so a wedged page cannot hang the heartbeat.
 * - Cleanup: {@link closeAgentBrowser} is called from the wake runner's finally block.
 *
 * Playwright objects are typed structurally (no playwright import) so unit tests can use
 * fakes; the live tests launch Chromium and skip when it is not installed.
 */
import { AgentBrowser, AgentBrowserThreadManager } from '@mastra/agent-browser';
import type { BrowserState } from '@mastra/core/browser';
import { BROWSER_ALWAYS_EXCLUDED_TOOLS, createTraceLogger } from '@tourbillon/shared';
import {
  checkBrowserUrl,
  describeBrowserEgressDenial,
  type BrowserEgressDecision,
  type BrowserEgressPolicy,
} from './browser-egress';
import { BROWSER_CLOSE_TIMEOUT_MS, type BrowserSettings } from './browser-settings';

// ── Minimal structural Playwright types ──────────────────────────────────────

export interface GuardRequest {
  url(): string;
  isNavigationRequest(): boolean;
  method(): string;
  headers(): Record<string, string>;
}
export interface GuardResponse {
  status(): number;
  headers(): Record<string, string>;
}
export interface GuardRoute {
  request(): GuardRequest;
  abort(errorCode?: string): Promise<void>;
  continue(): Promise<void>;
  fetch(options?: GuardFetchOptions): Promise<GuardResponse>;
  fulfill(options: { response: GuardResponse }): Promise<void>;
}
export interface GuardFetchOptions {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  postData?: string;
  maxRedirects?: number;
  timeout?: number;
}
export interface GuardWebSocketRoute {
  url(): string;
  close(options?: { code?: number; reason?: string }): Promise<void> | void;
  connectToServer(): unknown;
}
export interface GuardFrame {
  url(): string;
}
export interface GuardPage {
  mainFrame(): GuardFrame;
  on(event: 'framenavigated', handler: (frame: GuardFrame) => void): unknown;
  goto(url: string): Promise<unknown>;
}
export interface GuardContext {
  route(url: string, handler: (route: GuardRoute) => Promise<void>): Promise<void>;
  routeWebSocket?(url: RegExp, handler: (ws: GuardWebSocketRoute) => Promise<void> | void): Promise<void>;
  setDefaultTimeout(ms: number): void;
  setDefaultNavigationTimeout(ms: number): void;
  on(event: 'page', handler: (page: GuardPage) => void): unknown;
  pages(): GuardPage[];
}

export type BrowserDenial = Extract<BrowserEgressDecision, { allowed: false }> & { at: number };

export interface BrowserGuardHooks {
  onDenied?: (denial: BrowserDenial) => void;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** Most redirects one request may follow inside the guard (Chromium's own limit is 20). */
export const BROWSER_MAX_REDIRECT_HOPS = 10;
/** Never forwarded to a later hop; the context cookie jar adds the right cookies per URL. */
const HEADERS_DROPPED_ON_FOLLOW = new Set(['cookie', 'authorization', 'proxy-authorization', 'host', 'content-length']);
/** Dropped as well when a redirect turns the request into a body-less GET. */
const BODY_HEADERS = new Set(['content-type', 'content-encoding', 'content-language', 'content-location']);

type Denial = Extract<BrowserEgressDecision, { allowed: false }>;

function followHeaders(request: GuardRequest, dropBody: boolean): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers())) {
    const key = name.toLowerCase();
    if (HEADERS_DROPPED_ON_FOLLOW.has(key)) continue;
    if (dropBody && BODY_HEADERS.has(key)) continue;
    out[name] = value;
  }
  return out;
}

/**
 * Fetch a routed request without letting anything follow redirects on its own: every
 * hop's Location is checked, allowed hops are fetched here, up to the hop cap. Returns
 * the final response, or the denial that stopped the chain.
 */
async function fetchWithCheckedRedirects(
  route: GuardRoute,
  policy: BrowserEgressPolicy,
  timeoutMs: number,
): Promise<{ response: GuardResponse } | { denial: Denial } | { timedOut: true }> {
  const request = route.request();
  let current = request.url();
  let method = (request.method() || 'GET').toUpperCase();
  let dropBody = false;
  const deadline = Date.now() + timeoutMs;
  for (let hops = 0; ; hops += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { timedOut: true };
    const response =
      hops === 0
        ? await route.fetch({ maxRedirects: 0, timeout: remaining })
        : await route.fetch({
            url: current,
            method,
            headers: followHeaders(request, dropBody),
            ...(dropBody ? { postData: '' } : {}),
            maxRedirects: 0,
            timeout: remaining,
          });
    if (!REDIRECT_STATUSES.has(response.status())) return { response };
    const headers = response.headers();
    const location = headers.location ?? headers.Location;
    if (!location) return { response };
    let next: string;
    try {
      next = new URL(location, current).href;
    } catch {
      return { denial: { allowed: false, reason: 'invalid_url', host: null } };
    }
    const hop = await checkBrowserUrl(next, policy);
    if (!hop.allowed) return { denial: hop };
    if (hops >= BROWSER_MAX_REDIRECT_HOPS) {
      return { denial: { allowed: false, reason: 'too_many_redirects', host: hop.host } };
    }
    const status = response.status();
    if ((status === 303 && method !== 'HEAD') || ((status === 301 || status === 302) && method === 'POST')) {
      method = 'GET';
      dropBody = true;
    }
    current = next;
  }
}

const PAGE_SCHEMES_OK = new Set(['http:', 'https:', 'about:', 'chrome-error:']);

function schemeOf(url: string): string | null {
  try {
    return new URL(url).protocol;
  } catch {
    return null;
  }
}

/**
 * Install the egress route + timeouts on one browser context. Idempotent per context.
 * Exported for tests.
 */
const guardedContexts = new WeakSet<object>();

export async function installBrowserGuard(
  context: GuardContext,
  policy: BrowserEgressPolicy,
  settings: Pick<BrowserSettings, 'navTimeoutMs'>,
  hooks: BrowserGuardHooks = {},
): Promise<boolean> {
  if (guardedContexts.has(context)) return false;
  guardedContexts.add(context);

  context.setDefaultNavigationTimeout(settings.navTimeoutMs);
  context.setDefaultTimeout(settings.navTimeoutMs);

  const deny = (decision: Extract<BrowserEgressDecision, { allowed: false }>) => {
    hooks.onDenied?.({ ...decision, at: Date.now() });
  };

  await context.route('**/*', async (route) => {
    try {
      const request = route.request();
      const url = request.url();
      const decision = await checkBrowserUrl(url, policy);
      if (!decision.allowed) {
        deny(decision);
        await route.abort('blockedbyclient');
        return;
      }
      // Fetch here and hand the browser only the final response, so every redirect
      // hop goes through the same checks.
      const result = await fetchWithCheckedRedirects(route, policy, settings.navTimeoutMs);
      if ('denial' in result) {
        deny(result.denial);
        await route.abort('blockedbyclient');
        return;
      }
      if ('timedOut' in result) {
        await route.abort('timedout');
        return;
      }
      await route.fulfill({ response: result.response });
    } catch {
      try {
        await route.abort('failed');
      } catch {
        /* route already handled or page gone */
      }
    }
  });

  if (typeof context.routeWebSocket === 'function') {
    await context.routeWebSocket(/.*/, async (ws) => {
      const raw = ws.url();
      const httpUrl = raw.replace(/^ws(s?):/i, 'http$1:');
      const decision = /^wss?:/i.test(raw)
        ? await checkBrowserUrl(httpUrl, policy)
        : ({ allowed: false, reason: 'scheme_not_allowed', host: null } as const);
      if (!decision.allowed) {
        deny(decision);
        await ws.close({ code: 1008, reason: 'blocked' });
        return;
      }
      ws.connectToServer();
    });
  }

  // Backstop for navigations that never hit the network layer (file:, data:, …):
  // a main frame that lands on a non-http(s) document is sent back to about:blank.
  const watchPage = (page: GuardPage) => {
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      const url = frame.url();
      const scheme = schemeOf(url);
      if (scheme === 'http:' || scheme === 'https:') {
        // Defence in depth: a main frame on a refused http(s) address is sent back too.
        void checkBrowserUrl(url, policy)
          .then((decision) => {
            if (decision.allowed || frame.url() !== url) return;
            deny(decision);
            return page.goto('about:blank');
          })
          .catch(() => undefined);
        return;
      }
      if (scheme && PAGE_SCHEMES_OK.has(scheme)) return;
      deny({ allowed: false, reason: 'scheme_not_allowed', host: null });
      void page.goto('about:blank').catch(() => undefined);
    });
  };
  for (const page of context.pages()) watchPage(page);
  context.on('page', watchPage);

  return true;
}

// ── Step timeout wrapper ─────────────────────────────────────────────────────

export interface BrowserStepFailure {
  success: false;
  code: 'egress_denied' | 'timeout' | 'aborted';
  message: string;
  hint?: string;
}

type ToolLike = {
  id?: string;
  execute?: (input: any, context?: any) => Promise<unknown>;
};

const TIMEOUT = Symbol('timeout');
const ABORTED = Symbol('aborted');

const URL_TOOLS = new Set(['browser_goto', 'browser_tabs']);

export interface TourbillonAgentBrowserOptions {
  settings: BrowserSettings;
  policy: BrowserEgressPolicy;
  agentId?: string;
  companyId?: string;
  /** Bound on close(); default BROWSER_CLOSE_TIMEOUT_MS. */
  closeTimeoutMs?: number;
  /** Expose browser_screenshot (runtimeConfig.browser.screenshots). Default false. */
  screenshots?: boolean;
}

export class TourbillonAgentBrowser extends AgentBrowser {
  readonly guardSettings: BrowserSettings;
  readonly egressPolicy: BrowserEgressPolicy;
  private lastDenial: BrowserDenial | null = null;
  private readonly trace;
  private readonly closeTimeoutMs: number;
  readonly screenshotsEnabled: boolean;

  constructor(options: TourbillonAgentBrowserOptions) {
    const { settings, policy } = options;
    let self: TourbillonAgentBrowser | null = null;
    const excludeTools = [
      ...BROWSER_ALWAYS_EXCLUDED_TOOLS,
      ...(options.screenshots === true ? [] : ['browser_screenshot' as const]),
    ];
    super({
      headless: true,
      excludeTools,
      scope: 'thread',
      timeout: settings.navTimeoutMs,
      ...(settings.executablePath ? { executablePath: settings.executablePath } : {}),
      // Guard every per-thread browser as soon as it is created, before any tool uses it.
      createThreadManager: (config) =>
        new (class extends AgentBrowserThreadManager {
          protected override async createSession(threadId: string) {
            const session = await super.createSession(threadId);
            const ctx = session.manager?.getContext?.();
            if (ctx && self) await self.guardContext(ctx as unknown as GuardContext);
            return session;
          }

          // Guard the context first, then reopen only saved tabs that pass the checks again.
          protected override async restoreBrowserState(
            manager: unknown,
            state: BrowserState,
          ) {
            const ctx = (manager as unknown as { getContext?: () => unknown }).getContext?.();
            if (!ctx || !self) return; // cannot guard: do not reopen anything
            await self.guardContext(ctx as GuardContext);
            const safe = await self.filterRestorableState(state);
            if (safe) await super.restoreBrowserState(manager as never, safe);
          }
        })(config),
    });
    self = this;
    this.guardSettings = settings;
    this.egressPolicy = policy;
    this.closeTimeoutMs = options.closeTimeoutMs ?? BROWSER_CLOSE_TIMEOUT_MS;
    this.screenshotsEnabled = options.screenshots === true;
    this.trace = createTraceLogger('browser', {
      ...(options.agentId ? { agentId: options.agentId } : {}),
      ...(options.companyId ? { companyId: options.companyId } : {}),
    });
  }

  /** Install the egress route on a context (idempotent). */
  async guardContext(context: GuardContext): Promise<void> {
    await installBrowserGuard(context, this.egressPolicy, this.guardSettings, {
      onDenied: (denial) => this.recordDenial(denial),
    });
  }

  /**
   * Saved tabs that may be reopened: each URL is checked again with the current policy.
   * Returns null when nothing is left to restore. @internal
   */
  async filterRestorableState(state: BrowserState): Promise<BrowserState | null> {
    const tabs: BrowserState['tabs'] = [];
    let activeTabIndex = 0;
    for (const [index, tab] of (state.tabs ?? []).entries()) {
      if (!tab?.url) continue;
      const decision = await checkBrowserUrl(tab.url, this.egressPolicy, { navigation: true });
      if (!decision.allowed) {
        this.recordDenial(decision);
        continue;
      }
      if (index === state.activeTabIndex) activeTabIndex = tabs.length;
      tabs.push(tab);
    }
    if (tabs.length === 0) return null;
    return { ...state, tabs, activeTabIndex };
  }

  /** The provider's own relaunch navigation: checked like an agent navigation. */
  override async navigateTo(url: string): Promise<void> {
    const decision = await checkBrowserUrl(url, this.egressPolicy, { navigation: true });
    if (!decision.allowed) {
      this.recordDenial(decision);
      return;
    }
    await super.navigateTo(url);
  }

  private recordDenial(decision: Denial): void {
    const denial = { ...decision, at: Date.now() };
    this.lastDenial = denial;
    // Host and reason only — never the full URL.
    this.trace.warn('browser egress denied', { host: denial.host, reason: denial.reason });
  }

  /** Defensive: also guard on every ensureReady (no-op once installed). */
  override async ensureReady(): Promise<void> {
    await super.ensureReady();
    const manager = await this.getManagerForThread();
    const ctx = (manager as unknown as { getContext?: () => unknown })?.getContext?.();
    if (ctx) await this.guardContext(ctx as GuardContext);
  }

  /** Close the browser, bounded; never throws. */
  async closeQuietly(reason: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.close(),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            this.trace.warn('browser close timed out', { reason, timeoutMs: this.closeTimeoutMs });
            resolve();
          }, this.closeTimeoutMs);
        }),
      ]);
    } catch (err) {
      this.trace.warn('browser close failed', {
        reason,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  override getTools(): ReturnType<AgentBrowser['getTools']> {
    const tools = super.getTools();
    // Defensive: never expose these even if the provider ignores excludeTools.
    for (const name of BROWSER_ALWAYS_EXCLUDED_TOOLS) delete tools[name];
    if (!this.screenshotsEnabled) delete tools.browser_screenshot;
    for (const [name, tool] of Object.entries(tools)) {
      wrapBrowserTool(name, tool as ToolLike, this);
    }
    return tools;
  }

  /** @internal used by wrapBrowserTool */
  takeDenialSince(since: number): BrowserDenial | null {
    const d = this.lastDenial;
    if (d && d.at >= since) {
      this.lastDenial = null;
      return d;
    }
    return null;
  }
}

function denialResult(decision: Extract<BrowserEgressDecision, { allowed: false }>): BrowserStepFailure {
  return {
    success: false,
    code: 'egress_denied',
    message: describeBrowserEgressDenial(decision),
    hint: 'Do not retry this URL. Only public http(s) hosts allowed for this agent can be opened.',
  };
}

/**
 * Wrap one browser tool: pre-check URLs, clamp the navigation timeout the model asks
 * for, race the call against the step cap and the run's abort signal, and close the
 * browser if the step does not finish. Exported for tests.
 */
export function wrapBrowserTool(name: string, tool: ToolLike, browser: TourbillonAgentBrowser): void {
  const original = tool.execute;
  if (typeof original !== 'function') return;
  const { stepTimeoutMs, navTimeoutMs } = browser.guardSettings;

  tool.execute = async (input: any, context?: any) => {
    let args = input;
    if (URL_TOOLS.has(name) && input && typeof input === 'object' && typeof input.url === 'string') {
      const decision = await checkBrowserUrl(input.url, browser.egressPolicy, { navigation: true });
      if (!decision.allowed) return denialResult(decision);
    }
    if (name === 'browser_goto' && input && typeof input === 'object') {
      const asked = typeof input.timeout === 'number' && input.timeout > 0 ? input.timeout : navTimeoutMs;
      args = { ...input, timeout: Math.min(asked, navTimeoutMs) };
    }

    const signal: AbortSignal | undefined = context?.abortSignal;
    if (signal?.aborted) {
      await browser.closeQuietly('aborted');
      return { success: false, code: 'aborted', message: 'The run was aborted; the browser was closed.' } satisfies BrowserStepFailure;
    }

    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const work = Promise.resolve().then(() => original.call(tool, args, context));
    work.catch(() => undefined);
    const timeout = new Promise<typeof TIMEOUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT), stepTimeoutMs);
    });
    const aborted = new Promise<typeof ABORTED>((resolve) => {
      if (!signal) return;
      onAbort = () => resolve(ABORTED);
      signal.addEventListener('abort', onAbort, { once: true });
    });

    try {
      const result = await Promise.race([work, timeout, aborted]);
      if (result === TIMEOUT) {
        await browser.closeQuietly('step_timeout');
        return {
          success: false,
          code: 'timeout',
          message: `${name} did not finish within ${Math.round(stepTimeoutMs / 1000)}s; the browser was closed.`,
          hint: 'The next browser tool call starts a fresh browser.',
        } satisfies BrowserStepFailure;
      }
      if (result === ABORTED) {
        await browser.closeQuietly('aborted');
        return { success: false, code: 'aborted', message: 'The run was aborted; the browser was closed.' } satisfies BrowserStepFailure;
      }
      const denial = browser.takeDenialSince(startedAt);
      if (denial && isFailedResult(result)) return denialResult(denial);
      return result;
    } finally {
      if (timer) clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    }
  };
}

function isFailedResult(result: unknown): boolean {
  return !!result && typeof result === 'object' && (result as { success?: unknown }).success === false;
}
