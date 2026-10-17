import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { ROLE_DEFAULT_TOOLSETS, TOOLSET_CATALOG, VALID_TOOLSET_IDS } from '@tourbillon/shared';
import { ROLE_TOOLS } from '../tools/role-tools';
import { agentHasBrowserToolset, buildAgentBrowser, closeAgentBrowser, type BrowserModuleLoader } from './index';
import { resolveBrowserSettings } from './browser-settings';

const record = (assignedToolsets: string[], runtimeConfig: unknown = {}) => ({
  id: 'agent-1',
  companyId: 'co-1',
  assignedToolsets,
  runtimeConfig,
});

function spyLoader(): { loader: BrowserModuleLoader; calls: number; built: unknown[] } {
  const state = { calls: 0, built: [] as unknown[] };
  const loader: BrowserModuleLoader = async () => {
    state.calls += 1;
    class FakeBrowser {
      constructor(public options: unknown) {
        state.built.push(options);
      }
    }
    return { TourbillonAgentBrowser: FakeBrowser as never };
  };
  return { loader, get calls() { return state.calls; }, built: state.built } as never;
}

describe('browser toolset registry', () => {
  it('is in the toolset catalog (agent config picker) and valid ids', () => {
    const entry = TOOLSET_CATALOG.find((t) => t.id === 'browser');
    assert.ok(entry, 'catalog entry');
    assert.match(entry!.description, /playwright install --with-deps chromium/);
    assert.ok(VALID_TOOLSET_IDS.has('browser'));
  });

  it('is in the role-to-tools map', () => {
    assert.ok('browser' in ROLE_TOOLS);
  });

  it('is off by default for every role', () => {
    for (const [role, toolsets] of Object.entries(ROLE_DEFAULT_TOOLSETS)) {
      assert.ok(!toolsets.includes('browser'), role);
    }
  });

  it('gates on assignedToolsets', () => {
    assert.equal(agentHasBrowserToolset({ assignedToolsets: ['comments', 'browser'] }), true);
    assert.equal(agentHasBrowserToolset({ assignedToolsets: ['comments', 'web-search-tavily'] }), false);
    assert.equal(agentHasBrowserToolset({ assignedToolsets: null }), false);
  });
});

describe('buildAgentBrowser', () => {
  it('does not load or build a browser when the toolset is off', async () => {
    const spy = spyLoader();
    const browser = await buildAgentBrowser(record(['comments']), { loader: spy.loader, env: {} });
    assert.equal(browser, undefined);
    assert.equal(spy.calls, 0, 'provider module never imported');
  });

  it('builds the browser with env settings and the egress lists when on', async () => {
    const spy = spyLoader();
    const browser = await buildAgentBrowser(record(['browser'], { toolEgressAllowList: ['example.com'] }), {
      loader: spy.loader,
      companySettings: { toolEgressAllowList: ['example.com', 'other.org'] },
      env: {
        TOURBILLON_BROWSER_EXECUTABLE_PATH: '/usr/bin/chromium',
        TOURBILLON_BROWSER_STEP_TIMEOUT_MS: '20000',
        TOURBILLON_BROWSER_NAV_TIMEOUT_MS: '15000',
      },
    });
    assert.ok(browser);
    assert.equal(spy.calls, 1);
    const opts = spy.built[0] as any;
    assert.deepEqual(opts.settings, { executablePath: '/usr/bin/chromium', stepTimeoutMs: 20000, navTimeoutMs: 15000 });
    assert.deepEqual(opts.policy.hostAllowList, { company: ['example.com', 'other.org'], agent: ['example.com'] });
    assert.equal(opts.agentId, 'agent-1');
  });

  it('omits the browser when AGENT_BROWSER_PROVIDER would hand it to a cloud provider', async () => {
    const spy = spyLoader();
    const browser = await buildAgentBrowser(record(['browser']), { loader: spy.loader, env: { AGENT_BROWSER_PROVIDER: 'browserbase' } });
    assert.equal(browser, undefined);
    assert.equal(spy.calls, 0);
  });

  it('builds a real provider instance without launching Chromium', async () => {
    const browser = (await buildAgentBrowser(record(['browser']), { env: {} })) as any;
    assert.ok(browser);
    assert.equal(browser.isBrowserRunning(), false);
    assert.ok('browser_goto' in browser.getTools());
  });
});

describe('resolveBrowserSettings', () => {
  it('uses defaults and clamps', () => {
    assert.deepEqual(resolveBrowserSettings({}), { stepTimeoutMs: 45000, navTimeoutMs: 30000 });
    assert.deepEqual(
      resolveBrowserSettings({ TOURBILLON_BROWSER_STEP_TIMEOUT_MS: '9999999', TOURBILLON_BROWSER_NAV_TIMEOUT_MS: '9999999' }),
      { stepTimeoutMs: 120000, navTimeoutMs: 120000 },
    );
    assert.deepEqual(
      resolveBrowserSettings({ TOURBILLON_BROWSER_STEP_TIMEOUT_MS: '1', TOURBILLON_BROWSER_NAV_TIMEOUT_MS: 'abc' }),
      { stepTimeoutMs: 5000, navTimeoutMs: 5000 },
    );
  });
});

describe('closeAgentBrowser (run end)', () => {
  it('closes the attached browser and swallows errors', async () => {
    const closed: string[] = [];
    await closeAgentBrowser(
      { browser: { closeQuietly: async (reason: string) => void closed.push(reason) } },
      { browser: { close: async () => { throw new Error('boom'); } } },
      { browser: undefined },
      undefined,
    );
    assert.deepEqual(closed, ['run_end']);
  });
});
