import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  browserExcludedTools,
  isBrowserScreenshotsEnabled,
  nextBrowserRuntimeConfig,
} from '../browser-config';

describe('browser config', () => {
  it('screenshots are off unless explicitly true', () => {
    assert.equal(isBrowserScreenshotsEnabled(undefined), false);
    assert.equal(isBrowserScreenshotsEnabled({}), false);
    assert.equal(isBrowserScreenshotsEnabled({ browser: {} }), false);
    assert.equal(isBrowserScreenshotsEnabled({ browser: { screenshots: 'yes' as never } }), false);
    assert.equal(isBrowserScreenshotsEnabled({ browser: { screenshots: true } }), true);
  });

  it('browser_evaluate is always excluded; screenshot only when not opted in', () => {
    assert.deepEqual(browserExcludedTools({}), ['browser_evaluate', 'browser_screenshot']);
    assert.deepEqual(browserExcludedTools({ browser: { screenshots: true } }), ['browser_evaluate']);
  });

  it('writer stores, keeps or clears the sub-options', () => {
    assert.deepEqual(nextBrowserRuntimeConfig(undefined, ['browser'], { screenshots: true }), { screenshots: true });
    assert.deepEqual(nextBrowserRuntimeConfig({ screenshots: true }, ['browser'], { screenshots: false }), { screenshots: false });
    assert.deepEqual(nextBrowserRuntimeConfig({ screenshots: true }, ['browser'], undefined), { screenshots: true });
    assert.equal(nextBrowserRuntimeConfig({ screenshots: true }, ['comments'], { screenshots: true }), undefined);
  });
});
