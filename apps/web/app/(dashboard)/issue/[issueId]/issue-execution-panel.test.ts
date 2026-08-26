import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('IssueExecutionPanel endpoint usage', () => {
  it('does not reference /logs endpoint in module source', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    const modulePath = path.join(__dirname, 'issue-execution-panel.tsx');
    const source = await fs.readFile(modulePath, 'utf-8');

    const logsPattern = /\/api\/jobs\/.*?\/logs(?!\/)/g;
    const matches = source.match(logsPattern);

    assert.strictEqual(
      matches,
      null,
      `issue-execution-panel.tsx should not contain /logs endpoint references. Found: ${matches?.join(', ')}`,
    );
  });

  it('does not contain fetch calls to /logs', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    const modulePath = path.join(__dirname, 'issue-execution-panel.tsx');
    const source = await fs.readFile(modulePath, 'utf-8');

    const fetchLogsPattern = /fetch\([^)]*\/logs[^)]*\)/g;
    const matches = source.match(fetchLogsPattern);

    assert.strictEqual(
      matches,
      null,
      `issue-execution-panel.tsx should not fetch /logs endpoint. Found: ${matches?.join(', ')}`,
    );
  });
});
