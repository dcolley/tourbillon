import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

describe('AgentCodeExecutionForm egress allow-list editor', () => {
  it('renders the three modes, inline validation, help, and isolation warning', async () => {
    const source = await readFile(
      path.join(
        __dirname,
        '../app/(dashboard)/agent/[urlKey]/agent-code-execution-form.tsx',
      ),
      'utf-8',
    );

    assert.match(source, /egressAllowListMode/);
    assert.match(source, /Off/);
    assert.match(source, /Empty list/);
    assert.match(source, /List of entries/);
    assert.match(source, /parseEgressAllowListEntry/);
    assert.match(source, /@tourbillon\/shared\/egress-allow-list/);
    assert.match(source, /EGRESS_ALLOW_LIST_HELP/);
    assert.match(source, /EGRESS_ALLOW_LIST_ISOLATION_WARNING/);
    assert.match(source, /effectiveIsolation === 'none' \|\| effectiveIsolation === 'seatbelt'/);
    assert.doesNotMatch(source, /fetch\([^)]*egress/);
  });
});
