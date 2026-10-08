/**
 * #105 B1: server actions are callable by action id on ANY page path (e.g. POST /agent/x.png
 * with a Next-Action header), so proxy.ts is not enough on its own. Every 'use server'
 * function in the web app must call requireBoardSession() as its first statement.
 * Static check over the source so a new action without the guard fails CI.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const WEB_ROOT = path.join(__dirname, '..');
const GUARD = 'await requireBoardSession();';

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Returns `[file, functionName, guarded]` for every server action found. */
function findServerActions(): Array<[string, string, boolean]> {
  const found: Array<[string, string, boolean]> = [];
  const files = [...walk(path.join(WEB_ROOT, 'app')), ...walk(path.join(WEB_ROOT, 'components')), ...walk(path.join(WEB_ROOT, 'lib'))];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    const rel = path.relative(WEB_ROOT, file);
    const fileLevel = /^\s*['"]use server['"];?/.test(src);
    if (fileLevel) {
      // Every exported async function in a 'use server' module is an action.
      const re = /^export async function (\w+)\s*\(/gm;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        const bodyStart = findBodyStart(src, m.index + m[0].length - 1);
        const head = src.slice(bodyStart + 1).replace(/^\s*(['"]use server['"];?\s*)?/, '');
        found.push([rel, m[1], head.trimStart().startsWith(GUARD)]);
      }
    }
    // Inline actions: a function body whose first statement is 'use server'.
    const inline = /^([ \t]+)['"]use server['"];?\n/gm;
    let m: RegExpExecArray | null;
    while ((m = inline.exec(src))) {
      if (fileLevel && m.index < 20) continue;
      const before = src.slice(0, m.index);
      const fns = [...before.matchAll(/function\s+(\w+)/g)];
      const name = fns.length ? `${fns[fns.length - 1][1]}@${before.split('\n').length}` : `<anonymous>@${m.index}`;
      const after = src.slice(m.index + m[0].length);
      found.push([rel, name, after.trimStart().startsWith(GUARD)]);
    }
  }
  // De-duplicate (file-level actions that also carry an inline directive).
  const seen = new Map<string, [string, string, boolean]>();
  for (const f of found) {
    const key = `${f[0]}#${f[1]}`;
    const prev = seen.get(key);
    seen.set(key, prev ? [f[0], f[1], prev[2] && f[2]] : f);
  }
  return [...seen.values()];
}

/** Index of the `{` opening the function body (skips params and `Promise<{…}>` return types). */
function findBodyStart(src: string, parenIndex: number): number {
  let i = parenIndex;
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) break;
  }
  let angle = 0;
  let brace = 0;
  for (i++; i < src.length; i++) {
    const c = src[i];
    if (c === '<') angle++;
    else if (c === '>' && src[i - 1] !== '=') angle--;
    else if (c === '{') {
      if (angle === 0 && brace === 0) return i;
      brace++;
    } else if (c === '}') brace--;
  }
  throw new Error('function body not found');
}

describe('#105 B1 server-action board guards', () => {
  const actions = findServerActions();

  it('finds the known server actions (sanity)', () => {
    const names = new Set(actions.map(([, n]) => n));
    for (const n of [
      'toggleAgentActiveAction',
      'updateAgentRoleAction',
      'deleteAgentAction',
      'triggerAgentHeartbeatAction',
      'forceKillHeartbeatAction',
      'retryFailedHeartbeatAction',
      'createCompanyAction',
      'syncActiveCompanyAction',
      'createIssueAction',
      'commentOnIssueAction',
      'releaseCheckoutLockAction',
    ]) {
      assert.ok(names.has(n), `expected to find server action ${n}`);
    }
    assert.ok(actions.length >= 40, `found only ${actions.length} actions`);
  });

  it('every server action calls requireBoardSession() first', () => {
    const missing = actions.filter(([, , ok]) => !ok).map(([f, n]) => `${f}#${n}`);
    assert.deepEqual(missing, []);
  });
});
