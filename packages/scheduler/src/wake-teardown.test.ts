import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { releaseWakeResources } from './wake-teardown';

describe('releaseWakeResources', () => {
  it('destroys the workspace and closes the browser', async () => {
    const events: string[] = [];
    const browser = { closeQuietly: async (reason: string) => void events.push(`browser:${reason}`) };
    await releaseWakeResources(
      { getWorkspace: async () => ({ id: 'ws' }), browser },
      { destroyWorkspace: async () => void events.push('workspace') },
    );
    assert.deepEqual(events, ['workspace', 'browser:run_end']);
  });

  it('still closes the browser when workspace teardown throws', async () => {
    const events: string[] = [];
    const browser = { closeQuietly: async () => void events.push('browser') };
    await releaseWakeResources(
      { getWorkspace: async () => { throw new Error('ws gone'); }, browser },
      { destroyWorkspace: async () => void events.push('workspace') },
    );
    assert.deepEqual(events, ['browser']);
  });

  it('never throws when the browser close fails', async () => {
    await releaseWakeResources(
      { browser: { closeQuietly: async () => { throw new Error('chromium wedged'); } } },
    );
    await releaseWakeResources(undefined);
  });
});
