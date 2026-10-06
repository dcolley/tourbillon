import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

describe('AgentCodeExecutionForm LAN-blocking copy', () => {
  it('shows private-range and none/seatbelt warnings', async () => {
    const source = await readFile(
      path.join(__dirname, '../app/(dashboard)/agent/[urlKey]/agent-code-execution-form.tsx'),
      'utf-8',
    );
    assert.match(source, /EGRESS_PRIVATE_RANGES_HELP/);
    assert.match(source, /EGRESS_LAN_BLOCKING_NEEDS_BWRAP/);
    assert.match(source, /effectiveIsolation === 'none' \|\| effectiveIsolation === 'seatbelt'/);
    assert.match(source, /Private ranges are blocked unless listed explicitly/);
  });
});
