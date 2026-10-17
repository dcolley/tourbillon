/**
 * Playwright is mocked throughout: Chromium is not installed on CI / the dev box.
 * Fakes implement only the structural surface the guard uses.
 */
import { strict as assert } from 'node:assert';
import { describe, it, afterEach } from 'node:test';
import { AgentBrowserThreadManager } from '@mastra/agent-browser';
import {
  installBrowserGuard,
  TourbillonAgentBrowser,
  type GuardContext,
  type GuardFrame,
  type GuardPage,
  type GuardResponse,
  type GuardRoute,
  type GuardWebSocketRoute,
} from './tourbillon-agent-browser';
import type { BrowserEgressPolicy } from './browser-egress';
import type { HostResolver } from '../egress-private-ranges';

const resolve: HostResolver = async (host) => {
  const table: Record<string, string> = {
    'example.com': '93.184.216.34',
    'cdn.example.com': '93.184.216.36',
    'evil.example.net': '198.51.100.7',
    localhost: '127.0.0.1',
  };
  const ip = table[host];
  if (!ip) throw new Error('ENOTFOUND');
  return [{ address: ip, family: 4 }];
};
const policy: BrowserEgressPolicy = { hostAllowList: {}, resolve };
const listedPolicy: BrowserEgressPolicy = { hostAllowList: { company: ['example.com', '*.example.com'] }, resolve };
const settings = { stepTimeoutMs: 200, navTimeoutMs: 100 };

// ── Fakes ────────────────────────────────────────────────────────────────────

class FakePage implements GuardPage {
  handlers: Array<(f: GuardFrame) => void> = [];
  main: GuardFrame = { url: () => 'about:blank' };
  gotos: string[] = [];
  mainFrame() {
    return this.main;
  }
  on(_event: 'framenavigated', handler: (f: GuardFrame) => void) {
    this.handlers.push(handler);
  }
  async goto(url: string) {
    this.gotos.push(url);
  }
  navigate(url: string) {
    this.main = { url: () => url };
    for (const h of this.handlers) h(this.main);
  }
}

class FakeContext implements GuardContext {
  routeHandler?: (route: GuardRoute) => Promise<void>;
  wsHandler?: (ws: GuardWebSocketRoute) => Promise<void> | void;
  routeCalls = 0;
  defaultTimeout?: number;
  navTimeout?: number;
  pageListeners: Array<(p: GuardPage) => void> = [];
  existing: FakePage[] = [new FakePage()];
  async route(_url: string, handler: (route: GuardRoute) => Promise<void>) {
    this.routeCalls += 1;
    this.routeHandler = handler;
  }
  async routeWebSocket(_url: RegExp, handler: (ws: GuardWebSocketRoute) => Promise<void> | void) {
    this.wsHandler = handler;
  }
  setDefaultTimeout(ms: number) {
    this.defaultTimeout = ms;
  }
  setDefaultNavigationTimeout(ms: number) {
    this.navTimeout = ms;
  }
  on(_event: 'page', handler: (p: GuardPage) => void) {
    this.pageListeners.push(handler);
  }
  pages() {
    return this.existing;
  }
}

function fakeRoute(url: string, opts: { navigation?: boolean; status?: number; location?: string } = {}) {
  const calls: string[] = [];
  const response: GuardResponse = {
    status: () => opts.status ?? 200,
    headers: (): Record<string, string> => (opts.location ? { location: opts.location } : {}),
  };
  const route: GuardRoute = {
    request: () => ({ url: () => url, isNavigationRequest: () => opts.navigation ?? false }),
    abort: async (code?: string) => {
      calls.push(`abort:${code}`);
    },
    continue: async () => {
      calls.push('continue');
    },
    fetch: async (o?: { maxRedirects?: number }) => {
      calls.push(`fetch:maxRedirects=${o?.maxRedirects}`);
      return response;
    },
    fulfill: async () => {
      calls.push('fulfill');
    },
  };
  return { route, calls };
}

// ── Guard ────────────────────────────────────────────────────────────────────

describe('installBrowserGuard', () => {
  it('caps navigation and action timeouts and is idempotent', async () => {
    const ctx = new FakeContext();
    assert.equal(await installBrowserGuard(ctx, policy, settings), true);
    assert.equal(await installBrowserGuard(ctx, policy, settings), false);
    assert.equal(ctx.routeCalls, 1);
    assert.equal(ctx.navTimeout, 100);
    assert.equal(ctx.defaultTimeout, 100);
  });

  it('aborts subresource requests to local addresses and continues public ones', async () => {
    const ctx = new FakeContext();
    const denied: string[] = [];
    await installBrowserGuard(ctx, policy, settings, { onDenied: (d) => denied.push(`${d.reason}:${d.host}`) });
    const bad = fakeRoute('http://169.254.169.254/latest/meta-data/');
    await ctx.routeHandler!(bad.route);
    assert.deepEqual(bad.calls, ['abort:blockedbyclient']);
    const local = fakeRoute('http://localhost:3002/api/agents');
    await ctx.routeHandler!(local.route);
    assert.deepEqual(local.calls, ['abort:blockedbyclient']);
    const ok = fakeRoute('https://cdn.example.com/app.js');
    await ctx.routeHandler!(ok.route);
    assert.deepEqual(ok.calls, ['continue']);
    assert.deepEqual(denied, ['cloud_metadata:169.254.169.254', 'private_range:localhost']);
  });

  it('aborts requests to hosts off the allow-list', async () => {
    const ctx = new FakeContext();
    await installBrowserGuard(ctx, listedPolicy, settings);
    const off = fakeRoute('https://evil.example.net/x.png');
    await ctx.routeHandler!(off.route);
    assert.deepEqual(off.calls, ['abort:blockedbyclient']);
  });

  it('checks the Location of a navigation redirect before the browser follows it', async () => {
    const ctx = new FakeContext();
    await installBrowserGuard(ctx, policy, settings);
    const toLocal = fakeRoute('https://example.com/go', { navigation: true, status: 302, location: 'http://127.0.0.1:5432/' });
    await ctx.routeHandler!(toLocal.route);
    assert.deepEqual(toLocal.calls, ['fetch:maxRedirects=0', 'abort:blockedbyclient']);

    const toFile = fakeRoute('https://example.com/go', { navigation: true, status: 301, location: 'file:///etc/passwd' });
    await ctx.routeHandler!(toFile.route);
    assert.deepEqual(toFile.calls, ['fetch:maxRedirects=0', 'abort:blockedbyclient']);

    const toPublic = fakeRoute('https://example.com/go', { navigation: true, status: 302, location: '/landing' });
    await ctx.routeHandler!(toPublic.route);
    assert.deepEqual(toPublic.calls, ['fetch:maxRedirects=0', 'fulfill']);
  });

  it('closes WebSockets to refused destinations', async () => {
    const ctx = new FakeContext();
    await installBrowserGuard(ctx, policy, settings);
    let closed = false;
    let connected = false;
    await ctx.wsHandler!({ url: () => 'ws://127.0.0.1:9229/', close: () => void (closed = true), connectToServer: () => (connected = true) });
    assert.equal(closed, true);
    assert.equal(connected, false);
    closed = false;
    await ctx.wsHandler!({ url: () => 'wss://example.com/live', close: () => void (closed = true), connectToServer: () => (connected = true) });
    assert.equal(closed, false);
    assert.equal(connected, true);
  });

  it('sends a main frame that lands on file:// back to about:blank (existing and new pages)', async () => {
    const ctx = new FakeContext();
    await installBrowserGuard(ctx, policy, settings);
    const existing = ctx.existing[0]!;
    existing.navigate('file:///etc/passwd');
    assert.deepEqual(existing.gotos, ['about:blank']);
    existing.navigate('https://example.com/');
    existing.navigate('chrome-error://chromewebdata/');
    assert.deepEqual(existing.gotos, ['about:blank']);

    const popup = new FakePage();
    for (const l of ctx.pageListeners) l(popup);
    popup.navigate('data:text/html,hi');
    assert.deepEqual(popup.gotos, ['about:blank']);
  });
});

// ── Thread-manager hook (guard before first use) ────────────────────────────

describe('TourbillonAgentBrowser session hook', () => {
  const original = (AgentBrowserThreadManager.prototype as any).createSession;
  afterEach(() => {
    (AgentBrowserThreadManager.prototype as any).createSession = original;
  });

  it('installs the guard on every new per-thread browser context', async () => {
    const ctx = new FakeContext();
    (AgentBrowserThreadManager.prototype as any).createSession = async (threadId: string) => ({
      threadId,
      createdAt: Date.now(),
      manager: { getContext: () => ctx },
    });
    const browser = new TourbillonAgentBrowser({ settings, policy });
    await (browser as any).threadManager.createSession('hb-run-1');
    assert.equal(ctx.routeCalls, 1);
    assert.equal(ctx.navTimeout, 100);
  });

  it('passes the configured executable path and headless mode to the provider', () => {
    const browser = new TourbillonAgentBrowser({
      settings: { ...settings, executablePath: '/opt/chromium/chrome' },
      policy,
    });
    const cfg = (browser as any).threadManager.browserConfig;
    assert.equal(cfg.executablePath, '/opt/chromium/chrome');
    assert.equal(cfg.headless, true);
    assert.equal(cfg.cdpUrl, undefined);
  });
});

// ── Tool wrapping: pre-checks, timeouts, cleanup ────────────────────────────

function makeBrowser(overrides: Partial<{ stepTimeoutMs: number; navTimeoutMs: number }> = {}, p = policy) {
  const browser = new TourbillonAgentBrowser({
    settings: { ...settings, ...overrides },
    policy: p,
    closeTimeoutMs: 50,
  });
  const log = { ensureReady: 0, close: 0, gotoInputs: [] as unknown[] };
  (browser as any).ensureReady = async () => {
    log.ensureReady += 1;
  };
  (browser as any).close = async () => {
    log.close += 1;
  };
  (browser as any).goto = async (input: unknown) => {
    log.gotoInputs.push(input);
    return { success: true, url: (input as { url: string }).url };
  };
  return { browser, log };
}

const toolCtx = (extra: Record<string, unknown> = {}) => ({ agent: { threadId: 'hb-run-1' }, ...extra });

describe('browser tools', () => {
  it('refuses file://, local and off-list URLs before launching the browser', async () => {
    const { browser, log } = makeBrowser({}, listedPolicy);
    const goto = browser.getTools().browser_goto as any;
    for (const url of ['file:///etc/passwd', 'http://localhost:3002/', 'http://169.254.169.254/', 'https://evil.example.net/']) {
      const r = await goto.execute({ url }, toolCtx());
      assert.equal(r.success, false, url);
      assert.equal(r.code, 'egress_denied', url);
    }
    assert.equal(log.ensureReady, 0, 'browser never launched');
    assert.equal(log.gotoInputs.length, 0);
  });

  it('checks the url of browser_tabs new', async () => {
    const { browser, log } = makeBrowser();
    const tabs = browser.getTools().browser_tabs as any;
    const r = await tabs.execute({ action: 'new', url: 'file:///root/.ssh/id_rsa' }, toolCtx());
    assert.equal(r.code, 'egress_denied');
    assert.equal(log.ensureReady, 0);
  });

  it('clamps the navigation timeout the model asks for', async () => {
    const { browser, log } = makeBrowser();
    const goto = browser.getTools().browser_goto as any;
    const r = await goto.execute({ url: 'https://example.com/', timeout: 600_000 }, toolCtx());
    assert.equal(r.success, true);
    assert.equal((log.gotoInputs[0] as { timeout: number }).timeout, 100);
  });

  it('a step that exceeds the cap closes the browser and fails the step', async () => {
    const { browser, log } = makeBrowser({ stepTimeoutMs: 40 });
    (browser as any).goto = () => new Promise(() => undefined); // wedged page
    const goto = browser.getTools().browser_goto as any;
    const started = Date.now();
    const r = await goto.execute({ url: 'https://example.com/' }, toolCtx());
    assert.equal(r.success, false);
    assert.equal(r.code, 'timeout');
    assert.equal(log.close, 1, 'browser closed on timeout');
    assert.ok(Date.now() - started < 2_000);
  });

  it('a step aborted with the run closes the browser', async () => {
    const { browser, log } = makeBrowser({ stepTimeoutMs: 5_000 });
    (browser as any).goto = () => new Promise(() => undefined);
    const goto = browser.getTools().browser_goto as any;
    const ac = new AbortController();
    const pending = goto.execute({ url: 'https://example.com/' }, toolCtx({ abortSignal: ac.signal }));
    setTimeout(() => ac.abort(), 10);
    const r = await pending;
    assert.equal(r.code, 'aborted');
    assert.equal(log.close, 1);
  });

  it('close is bounded even if Chromium hangs on close', async () => {
    const { browser } = makeBrowser();
    (browser as any).close = () => new Promise(() => undefined);
    let guard: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      browser.closeQuietly('test').then(() => 'returned'),
      new Promise<string>((resolve) => {
        guard = setTimeout(() => resolve('hung'), 1_000);
      }),
    ]);
    clearTimeout(guard);
    assert.equal(outcome, 'returned');
  });

  it('maps a route denial during the step to a clear tool error', async () => {
    const { browser } = makeBrowser();
    const ctx = new FakeContext();
    await browser.guardContext(ctx);
    (browser as any).goto = async () => {
      // the page redirected to a local address; the route aborted it
      await ctx.routeHandler!(fakeRoute('https://example.com/r', { navigation: true, status: 302, location: 'http://10.0.0.1/' }).route);
      return { success: false, code: 'browser_error', message: 'net::ERR_BLOCKED_BY_CLIENT' };
    };
    const r = await (browser.getTools().browser_goto as any).execute({ url: 'https://example.com/r' }, toolCtx());
    assert.equal(r.code, 'egress_denied');
    assert.match(r.message, /10\.0\.0\.1/);
  });
});
