import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('JobLogPanel endpoint usage', () => {
  it('does not reference /logs endpoint in module source', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    const modulePath = path.join(__dirname, 'job-log-panel.tsx');
    const source = await fs.readFile(modulePath, 'utf-8');

    const logsPattern = /\/api\/jobs\/.*?\/logs(?!\/)/g;
    const matches = source.match(logsPattern);

    assert.strictEqual(
      matches,
      null,
      `job-log-panel.tsx should not contain /logs endpoint references. Found: ${matches?.join(', ')}`,
    );
  });

  it('only uses /live endpoint for fetching job data', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    const modulePath = path.join(__dirname, 'job-log-panel.tsx');
    const source = await fs.readFile(modulePath, 'utf-8');

    const livePattern = /\/api\/jobs\/.*?\/live/g;
    const liveMatches = source.match(livePattern);

    assert.ok(liveMatches, 'job-log-panel.tsx should use /live endpoint');
    assert.ok(liveMatches.length > 0, 'job-log-panel.tsx should have at least one /live endpoint call');
  });
});
