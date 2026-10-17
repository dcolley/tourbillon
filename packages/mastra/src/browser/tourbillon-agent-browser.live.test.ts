/**
 * Live-Chromium checks for the browser egress guard: session restore and redirect
 * chains. Uses local HTTP servers only. `localhost` stands in for an allowed public
 * host (the test resolver maps it to a public address); `127.0.0.1` is the refused
 * local canary. Skipped when Chromium cannot be launched on this machine.
 */
import { strict as assert } from 'node:assert';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it, type TestContext } from 'node:test';
import { BROWSER_MAX_REDIRECT_HOPS, TourbillonAgentBrowser } from './tourbillon-agent-browser';
import type { BrowserEgressPolicy } from './browser-egress';
import type { HostResolver } from '../egress-private-ranges';

const resolve: HostResolver = async (host) => {
  if (host === 'localhost') return [{ address: '93.184.216.34', family: 4 }];
  throw new Error('ENOTFOUND');
};
const policy: BrowserEgressPolicy = { hostAllowList: {}, resolve };
const settings = { stepTimeoutMs: 20_000, navTimeoutMs: 10_000 };

interface Server {
  base: string;
  hits: string[];
  close: () => Promise<void>;
}

async function startServer(host: string, handler: (req: http.IncomingMessage, res: http.ServerResponse, base: string) => void): Promise<Server> {
  const hits: string[] = [];
  let base = '';
  const server = http.createServer((req, res) => {
    hits.push(req.url ?? '');
    handler(req, res, base);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://${host}:${(server.address() as AddressInfo).port}`;
  return {
    base,
    hits,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

let canary: Server;
let site: Server;
let chromiumOk = false;

const html = (res: http.ServerResponse, body: string) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html><title>t</title><body>${body}</body>`);
};
const redirect = (res: http.ServerResponse, location: string, status = 302) => {
  res.writeHead(status, { location });
  res.end();
};

before(async () => {
  canary = await startServer('127.0.0.1', (_req, res) => html(res, 'canary'));
  site = await startServer('localhost', (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const p = url.pathname;
    if (p === '/hop1') return redirect(res, '/redir');
    if (p === '/redir') return redirect(res, `${canary.base}/chain`);
    if (p === '/single') return redirect(res, `${canary.base}/single`, 307);
    if (p === '/c1') return redirect(res, '/c2', 301);
    if (p === '/c2') return redirect(res, '/c3', 303);
    if (p === '/c3') return html(res, '<p id="final">final-ok</p>');
    if (p.startsWith('/loop/')) return redirect(res, `/loop/${Number(p.slice(6)) + 1}`);
    if (p === '/with-img') return html(res, `<img src="/img-redir"><p>img page</p>`);
    if (p === '/img-redir') return redirect(res, `${canary.base}/img`);
    return html(res, `page ${p}`);
  });
  // Can Chromium start here?
  const probe = new TourbillonAgentBrowser({ settings, policy, closeTimeoutMs: 5_000 });
  try {
    await probe.ensureReady();
    await (probe as any).getManagerForThread('probe');
    chromiumOk = true;
  } catch {
    chromiumOk = false;
  } finally {
    await probe.closeQuietly('probe');
  }
});

after(async () => {
  await canary?.close();
  await site?.close();
});

function needChromium(t: TestContext): boolean {
  if (!chromiumOk) t.skip('Chromium cannot be launched here');
  return chromiumOk;
}

/** Capture `browser egress denied` trace lines. */
function captureDenials(): { lines: string[]; stop: () => void } {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    const line = args.map(String).join(' ');
    if (line.includes('browser egress denied')) lines.push(line);
    else original(...args);
  };
  return { lines, stop: () => void (console.warn = original) };
}

/**
 * After a refused navigation Chromium commits its error page a moment later; a goto
 * issued in that window is reported as interrupted (Playwright behaviour, unrelated to
 * the guard). Agents never act that fast; tests wait it out.
 */
const settle = () => new Promise((r) => setTimeout(r, 300));

async function pageFor(browser: TourbillonAgentBrowser, threadId: string) {
  const manager = await (browser as any).getManagerForThread(threadId);
  return manager.getPage() as { url(): string; content(): Promise<string> };
}

describe('live: session restore', { concurrency: false }, () => {
  it('a relaunch with a saved tab on a local canary does not reach it; allowed saved tabs still restore', async (t) => {
    if (!needChromium(t)) return;
    const cap = captureDenials();
    const browser = new TourbillonAgentBrowser({ settings, policy, closeTimeoutMs: 5_000 });
    try {
      await browser.ensureReady();
      const tm = (browser as any).threadManager;
      const before = canary.hits.length;
      tm.updateBrowserState('t-canary', { tabs: [{ url: `${canary.base}/restore` }], activeTabIndex: 0 });
      const page = await pageFor(browser, 't-canary');
      assert.equal(page.url(), 'about:blank');
      assert.equal(canary.hits.length, before, 'canary not hit on restore');
      assert.ok(cap.lines.some((l) => l.includes('127.0.0.1') && l.includes('private_range')), 'denial logged');

      // mixed: refused tab dropped, allowed one restored and active
      tm.updateBrowserState('t-mixed', {
        tabs: [{ url: `${canary.base}/restore2` }, { url: `${site.base}/saved` }],
        activeTabIndex: 1,
      });
      const mixed = await pageFor(browser, 't-mixed');
      assert.equal(mixed.url(), `${site.base}/saved`);
      assert.match(await mixed.content(), /page \/saved/);
      assert.equal(canary.hits.length, before, 'canary still not hit');
    } finally {
      cap.stop();
      await browser.closeQuietly('test');
    }
  });

  it('a real close and relaunch restores an allowed tab through the guard', async (t) => {
    if (!needChromium(t)) return;
    const browser = new TourbillonAgentBrowser({ settings, policy, closeTimeoutMs: 5_000 });
    try {
      const goto = browser.getTools().browser_goto as any;
      const r = await goto.execute({ url: `${site.base}/first` }, { agent: { threadId: 't-real' } });
      assert.equal(r.success, true, JSON.stringify(r));
      await (browser as any).closeThreadSession('t-real');
      const hitsBefore = site.hits.filter((h) => h === '/first').length;
      const page = await pageFor(browser, 't-real');
      assert.equal(page.url(), `${site.base}/first`);
      assert.equal(site.hits.filter((h) => h === '/first').length, hitsBefore + 1, 'restored via the guarded route');
    } finally {
      await browser.closeQuietly('test');
    }
  });
});

describe('live: redirect chains', { concurrency: false }, () => {
  let browser: TourbillonAgentBrowser;
  let goto: any;
  before(async () => {
    if (!chromiumOk) return;
    browser = new TourbillonAgentBrowser({ settings, policy, closeTimeoutMs: 5_000 });
    goto = browser.getTools().browser_goto as any;
  });
  after(async () => {
    if (browser) await browser.closeQuietly('test');
  });
  const ctx = { agent: { threadId: 't-redirect' } };

  it('a multi-hop chain that ends on a local address is denied and logged', async (t) => {
    if (!needChromium(t)) return;
    const cap = captureDenials();
    try {
      const before = canary.hits.length;
      const r = await goto.execute({ url: `${site.base}/hop1` }, ctx);
      assert.equal(r.success, false);
      assert.equal(r.code, 'egress_denied', JSON.stringify(r));
      assert.match(r.message, /127\.0\.0\.1/);
      assert.equal(canary.hits.length, before, 'canary not hit');
      assert.ok(cap.lines.some((l) => l.includes('127.0.0.1') && l.includes('private_range')), 'denial logged');
    } finally {
      cap.stop();
      await settle();
    }
  });

  it('a single hop to a local address is still denied', async (t) => {
    if (!needChromium(t)) return;
    const before = canary.hits.length;
    const r = await goto.execute({ url: `${site.base}/single` }, ctx);
    assert.equal(r.code, 'egress_denied', JSON.stringify(r));
    assert.equal(canary.hits.length, before);
    await settle();
  });

  it('an all-allowed multi-hop chain works', async (t) => {
    if (!needChromium(t)) return;
    const r = await goto.execute({ url: `${site.base}/c1` }, ctx);
    assert.equal(r.success, true, JSON.stringify(r));
    const page = await pageFor(browser, 't-redirect');
    assert.match(await page.content(), /final-ok/);
    for (const p of ['/c1', '/c2', '/c3']) assert.ok(site.hits.includes(p), p);
  });

  it('a redirect loop stops at the hop cap', async (t) => {
    if (!needChromium(t)) return;
    const before = site.hits.filter((h) => h.startsWith('/loop/')).length;
    const r = await goto.execute({ url: `${site.base}/loop/0` }, ctx);
    assert.equal(r.success, false);
    assert.equal(r.code, 'egress_denied', JSON.stringify(r));
    assert.match(r.message, /redirected too many times/);
    const fetched = site.hits.filter((h) => h.startsWith('/loop/')).length - before;
    assert.equal(fetched, BROWSER_MAX_REDIRECT_HOPS + 1);
    await settle();
  });

  it('a subresource redirect to a local address is not followed', async (t) => {
    if (!needChromium(t)) return;
    const before = canary.hits.length;
    const r = await goto.execute({ url: `${site.base}/with-img` }, ctx);
    assert.equal(r.success, true, JSON.stringify(r));
    await new Promise((res) => setTimeout(res, 300));
    assert.ok(site.hits.includes('/img-redir'));
    assert.equal(canary.hits.length, before, 'canary not hit');
  });
});
