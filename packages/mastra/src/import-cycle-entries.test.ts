/**
 * S235-S1 (#235 ACCEPT): cycle break must hold from EVERY entry point.
 *
 * S189-S1b broke the tool-discovery-tools ↔ agent-factory ↔ control-plane-tools static
 * import cycle by making tool-discovery-tools lazy-load agent-factory at execute time. The
 * only thing that pinned the break was the tool-discovery-tools suite itself loading fine.
 * A regression that re-introduces a static back-edge but is entered from a different module
 * (e.g. agent-factory or control-plane-tools imported first by some future suite) could
 * still hit the tsx CJS TDZ crash — "Cannot access 'TOOL_DISCOVERY_TOOLS' before
 * initialization" — that the removed load-order pin used to guard.
 *
 * This file spawns one fresh tsx process per cycle module, each importing that module
 * FIRST (nothing else from the cycle loaded), and requires a clean exit. If the lazy import
 * in tool-discovery-tools.ts is reverted to a static import, the entries that place
 * tool-discovery-tools mid-cycle go RED.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';

process.env.DATABASE_URL ??= 'postgres://user:***@127.0.0.1:5432/unused';

const PKG_ROOT = path.join(__dirname, '..'); // packages/mastra

// The three modules that formed the cycle per #235 (see the S189-S1b comment in
// tool-discovery-tools.ts): each is loaded alone, as the very first cycle entry.
const CYCLE_ENTRIES = [
  'src/tools/tool-discovery-tools.ts',
  'src/agent-factory.ts',
  'src/tools/control-plane-tools.ts',
];

function tsxBin(): string {
  const exe = process.platform === 'win32' ? 'tsx.cmd' : 'tsx';
  for (const dir of [
    path.join(PKG_ROOT, 'node_modules', '.bin'),
    path.join(PKG_ROOT, '..', '..', 'node_modules', '.bin'),
  ]) {
    const p = path.join(dir, exe);
    if (existsSync(p)) return p;
  }
  return exe; // fall back to PATH (same resolution order as apps/web/scripts/run-tests.mjs)
}

describe('import-cycle entries (S235-S1: cycle break from every entry)', () => {
  for (const entry of CYCLE_ENTRIES) {
    it(`loads '${entry}' first, in a fresh process, without the TDZ crash`, () => {
      const abs = path.join(PKG_ROOT, entry);
      assert.ok(existsSync(abs), `cycle entry exists: ${entry}`);
      // Loader script: import ONLY this module — no sibling cycle module is loaded first,
      // so any surviving static cycle surfaces as the tsx CJS TDZ crash.
      const loader = `import(${JSON.stringify(pathToFileURL(abs).href)}).then(() => process.exit(0), (e) => { console.error(String(e && e.stack || e)); process.exit(1); });`;
      const res = spawnSync(tsxBin(), ['-e', loader], {
        cwd: PKG_ROOT,
        encoding: 'utf8',
        timeout: 120_000,
        env: process.env,
        shell: process.platform === 'win32',
      });
      const stderr = res.stderr ?? '';
      assert.equal(res.status, 0, `fresh import of ${entry} must exit 0 (stderr: ${stderr.slice(0, 500)})`);
      assert.doesNotMatch(
        stderr,
        /Cannot access '.*' before initialization/,
        `${entry} first re-triggered the tool-discovery cycle TDZ crash — the lazy import in tool-discovery-tools.ts is load-bearing`,
      );
    });
  }
});
