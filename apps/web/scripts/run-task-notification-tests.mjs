#!/usr/bin/env node
/**
 * Dedicated runner for the service-backed task-notification certification suite.
 * Does not replace test:harness. Fails on skip/todo and on missing/extra cell names.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export const WEB_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const FILE_LIST = ['lib/assistant/task-notification-boundary.test.ts'];
export const EXPECTED_CELLS = [
  'TN-PROVENANCE-PREFLIGHT',
  'TN-DEFAULT-PATH',
  'TN-IDLE-DONE',
  'TN-IDLE-FAIL',
  'TN-BUSY-UNRELATED-PIN',
  'TN-BUSY-ORIGIN-HELD',
  'TN-CONCURRENT-THREAD-SWITCH',
  'TN-CONCURRENT-ORIGIN-NOTICES',
  'TN-CONCURRENT-AGENT-COMPANY',
  'TN-ONCE-DUP',
  'TN-WRONG-THREAD-LIVE',
  'TN-ORIGIN-MISSING-TASK',
  'TN-ORIGIN-MISSING-SOURCE',
  'TN-ORIGIN-LOOKUP-COMPANY-SCOPE',
  'TN-MODEL-OVERRIDE-ISOLATION',
  'TN-SUBSCRIBE-ACK',
  'TN-STOP-BEFORE-ACK',
  'TN-STOP-BORROWED-CLIENTS',
  'TN-STOP-IDEMPOTENT',
  'TN-DRAIN-TIMEOUT',
  'TN-RESTART-FRESH-CLIENTS',
  'TN-FAIL-CLEAN-INNER',
  'TN-FAIL-CLEAN-CONTROL',
  'TN-TEARDOWN',
];

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function discoverNames(source) {
  const names = [];
  const re = /test\(\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(source))) names.push(m[1]);
  return names;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.env.TN_DISPOSABLE !== '1') {
    console.error('run-task-notification-tests: TN_DISPOSABLE=1 is required');
    process.exit(1);
  }
  for (const file of FILE_LIST) {
    if (!existsSync(join(WEB_ROOT, file))) {
      console.error(`missing pinned path ${file}`);
      process.exit(1);
    }
  }
  const source = readFileSync(join(WEB_ROOT, FILE_LIST[0]), 'utf8');
  const discovered = discoverNames(source);
  const missing = EXPECTED_CELLS.filter((n) => !discovered.includes(n));
  const extra = discovered.filter((n) => !EXPECTED_CELLS.includes(n));
  if (missing.length || extra.length) {
    console.error('TN-MANIFEST name mismatch', { missing, extra, discovered });
    process.exit(1);
  }
  if (/test\.(skip|todo)\(/.test(source) || /\bit\.(skip|todo)\(/.test(source)) {
    console.error('TN-MANIFEST: skip/todo leaves are forbidden');
    process.exit(1);
  }
  const outDir = process.env.TN_EVIDENCE_DIR;
  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(
      join(outDir, 'manifest.json'),
      JSON.stringify(
        {
          fileList: FILE_LIST,
          fileSha256: sha256(source),
          expectedCells: EXPECTED_CELLS,
          expectedCellsSha256: sha256(EXPECTED_CELLS.join('\n') + '\n'),
          discovered,
        },
        null,
        2,
      ),
    );
  }
  const result = spawnSync('pnpm', ['exec', 'tsx', '--test', ...FILE_LIST], {
    cwd: WEB_ROOT,
    stdio: 'inherit',
    env: process.env,
  });
  process.exit(result.status ?? 1);
}
