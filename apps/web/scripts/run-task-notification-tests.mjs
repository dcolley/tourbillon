#!/usr/bin/env node
/**
 * Dedicated runner for the service-backed task-notification certification suite.
 * Does not replace test:harness. Fails on skip/todo and on missing/extra cell names.
 * Enforces committed file-list.txt / expected-cells.txt, actual TAP results, and
 * (when TN_REQUIRE_FIXED_CAPABLE=1) rejects capability-gated INCOMPAT verdicts.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export const WEB_ROOT = fileURLToPath(new URL('..', import.meta.url));
const ASSISTANT_DIR = join(WEB_ROOT, 'lib/assistant');
const COMMITTED_FILE_LIST_PATH = join(ASSISTANT_DIR, 'file-list.txt');
const COMMITTED_CELLS_PATH = join(ASSISTANT_DIR, 'expected-cells.txt');

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

function readCommittedLines(path) {
  if (!existsSync(path)) {
    console.error(`TN-MANIFEST: missing committed pin ${path}`);
    process.exit(1);
  }
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

function toWebRelative(repoOrWebPath) {
  if (repoOrWebPath.startsWith('apps/web/')) return repoOrWebPath.slice('apps/web/'.length);
  return repoOrWebPath;
}

function parseTap(output) {
  const names = [];
  const skipped = [];
  const todos = [];
  const cancelled = [];
  const failed = [];
  const seen = new Map();
  for (const line of output.split(/\r?\n/)) {
    let m = /^(ok|not ok)\s+\d+\s+-\s+(\S+)/.exec(line);
    if (!m) m = /^(ok|not ok)\s+\d+\s+(\S+)/.exec(line);
    if (m) {
      const [, status, name] = m;
      if (!name.startsWith('TN-')) continue;
      names.push(name);
      seen.set(name, (seen.get(name) ?? 0) + 1);
      if (status === 'not ok') failed.push(name);
      continue;
    }
    if (/#\s+skip\b/i.test(line) && /TN-/.test(line)) skipped.push(line);
    if (/#\s+todo\b/i.test(line) && /TN-/.test(line)) todos.push(line);
    const n = /# cancelled (\d+)/.exec(line);
    if (n && Number(n[1]) > 0) cancelled.push(line);
  }
  const duplicates = [...seen.entries()].filter(([, n]) => n > 1).map(([name, n]) => `${name} x${n}`);
  const summary = {
    tests: Number((/# tests (\d+)/.exec(output) ?? [])[1] ?? names.length),
    pass: Number((/# pass (\d+)/.exec(output) ?? [])[1] ?? NaN),
    fail: Number((/# fail (\d+)/.exec(output) ?? [])[1] ?? failed.length),
    skipped: Number((/# skipped (\d+)/.exec(output) ?? [])[1] ?? 0),
    todo: Number((/# todo (\d+)/.exec(output) ?? [])[1] ?? 0),
    cancelled: Number((/# cancelled (\d+)/.exec(output) ?? [])[1] ?? 0),
  };
  return { names, failed, skipped, todos, cancelled, duplicates, summary };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  // S355-S5: every certification log must carry the SHA of the tree under test.
  const headSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: join(WEB_ROOT, '..', '..'), encoding: 'utf8' }).stdout.trim();
  console.log(`run-task-notification-tests: HEAD=${headSha}`);

  if (process.env.TN_DISPOSABLE !== '1') {
    console.error('run-task-notification-tests: TN_DISPOSABLE=1 is required');
    process.exit(1);
  }

  const committedFiles = readCommittedLines(COMMITTED_FILE_LIST_PATH).map(toWebRelative);
  const committedCells = readCommittedLines(COMMITTED_CELLS_PATH);
  if (committedFiles.length === 0 || committedCells.length === 0) {
    console.error('TN-MANIFEST: committed file-list/expected-cells produced no entries');
    process.exit(1);
  }

  for (const file of committedFiles) {
    if (!existsSync(join(WEB_ROOT, file))) {
      console.error(`missing pinned path ${file}`);
      process.exit(1);
    }
  }

  const source = readFileSync(join(WEB_ROOT, committedFiles[0]), 'utf8');
  const discovered = discoverNames(source);
  const missing = committedCells.filter((n) => !discovered.includes(n));
  const extra = discovered.filter((n) => !committedCells.includes(n));
  if (missing.length || extra.length) {
    console.error('TN-MANIFEST name mismatch vs committed expected-cells.txt', { missing, extra, discovered });
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
          fileList: committedFiles,
          fileListPath: 'lib/assistant/file-list.txt',
          fileListSha256: sha256(readFileSync(COMMITTED_FILE_LIST_PATH, 'utf8')),
          fileSha256: sha256(source),
          expectedCells: committedCells,
          expectedCellsPath: 'lib/assistant/expected-cells.txt',
          expectedCellsSha256: sha256(readFileSync(COMMITTED_CELLS_PATH, 'utf8')),
          discovered,
        },
        null,
        2,
      ),
    );
  }

  const result = spawnSync('pnpm', ['exec', 'tsx', '--test', '--test-concurrency=1', '--test-reporter=tap', ...committedFiles], {
    cwd: WEB_ROOT,
    encoding: 'utf8',
    env: process.env,
  });
  const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');

  const tap = parseTap(combined);
  if (outDir) writeFileSync(join(outDir, 'tap-summary.json'), JSON.stringify(tap, null, 2));

  if (tap.duplicates.length) {
    console.error('TN-TAP: duplicate cell names', tap.duplicates);
    process.exit(1);
  }
  const tapMissing = committedCells.filter((n) => !tap.names.includes(n));
  const tapExtra = tap.names.filter((n) => !committedCells.includes(n));
  if (tapMissing.length || tapExtra.length) {
    console.error('TN-TAP: discovered TAP names mismatch committed expected-cells.txt', {
      tapMissing,
      tapExtra,
      tapNames: tap.names,
    });
    process.exit(1);
  }
  if (tap.summary.skipped > 0 || tap.skipped.length) {
    console.error('TN-TAP: skipped results are forbidden', tap.summary, tap.skipped);
    process.exit(1);
  }
  if (tap.summary.todo > 0 || tap.todos.length) {
    console.error('TN-TAP: todo results are forbidden', tap.summary, tap.todos);
    process.exit(1);
  }
  if (tap.summary.cancelled > 0 || tap.cancelled.length) {
    console.error('TN-TAP: cancelled results are forbidden', tap.summary, tap.cancelled);
    process.exit(1);
  }

  if (process.env.TN_REQUIRE_FIXED_CAPABLE === '1') {
    const verdictPath = outDir ? join(outDir, 'verdicts.json') : join(WEB_ROOT, '.tn-verdicts.json');
    if (!existsSync(verdictPath)) {
      console.error('TN-CAPABLE: TN_REQUIRE_FIXED_CAPABLE=1 but no verdicts.json was written');
      process.exit(1);
    }
    const verdicts = JSON.parse(readFileSync(verdictPath, 'utf8'));
    const incompat = (Array.isArray(verdicts) ? verdicts : []).filter((v) =>
      String(v.verdict ?? '').includes('INCOMPAT'),
    );
    if (incompat.length) {
      console.error('TN-CAPABLE: capability-gated INCOMPAT is forbidden on FIXED', incompat);
      process.exit(1);
    }
    console.log(
      `TN-CAPABLE: TN_REQUIRE_FIXED_CAPABLE=1 enforced — ${verdicts.length} verdicts read, 0 INCOMPAT (FIXED capability accepted)`,
    );
  }

  process.exit(result.status ?? 1);
}
