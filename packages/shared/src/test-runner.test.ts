/**
 * #122 follow-up S7: `pnpm test` in packages/shared must include top-level test files such as
 * src/wake-message.test.ts on Node 20 (pnpm's sh has no globstar, and Node 20 does not expand
 * quoted globs).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// @ts-expect-error plain .mjs script without type declarations
import { testTargets } from '../scripts/run-tests.mjs';

describe('S7: shared test runner', () => {
  it('package.json `test` uses the Node-20-safe runner', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    assert.equal(pkg.scripts.test, 'node scripts/run-tests.mjs');
  });

  it('Node 20: explicit sorted list including top-level and nested test files', () => {
    const files: string[] = testTargets(20);
    assert.ok(files.includes('src/wake-message.test.ts'), 'top-level wake-message.test.ts');
    assert.ok(files.includes('src/wake-context/hardening.test.ts'), 'nested test file');
    assert.ok(files.includes('src/test-runner.test.ts'));
    assert.deepEqual(files, [...files].sort());
    assert.ok(files.every((f) => f.endsWith('.test.ts')));
  });

  it('Node >= 21: hands the glob to Node', () => {
    assert.deepEqual(testTargets(22), ['src/**/*.test.ts']);
  });
});
