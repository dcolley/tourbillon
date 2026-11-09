#!/usr/bin/env node
/**
 * Per-control discriminating mutants for #112 (Test M1 + Hold musts).
 * Each mutant patches product source, runs ONE named test expecting FAIL, restores.
 * Always restores sources (no leftover .bak). Prints SHA stamp + raw fail snippets.
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const WEB = join(ROOT, 'apps/web');
const statePath = join(WEB, 'lib/vault-oauth-state.ts');
const cbPath = join(WEB, 'app/api/vault/oauth/callback/route.ts');
const azPath = join(WEB, 'app/api/vault/oauth/authorize/route.ts');
const storePath = join(WEB, 'lib/vault-oauth-nonce-store.ts');
const tracked = [statePath, cbPath, azPath, storePath];

const url = new URL(process.env.DATABASE_URL ?? 'postgres://x@invalid/none');
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !url.pathname.slice(1).startsWith('tb112_')) {
  console.error('mutants: need loopback tb112_* DATABASE_URL');
  process.exit(2);
}

const headSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
console.log(`mutants: HEAD=${headSha} WEB=${WEB}`);

function sha(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 12);
}
const origSha = Object.fromEntries(tracked.map((p) => [p, sha(p)]));
const originals = Object.fromEntries(tracked.map((p) => [p, readFileSync(p, 'utf8')]));

function restoreAll() {
  for (const p of tracked) {
    writeFileSync(p, originals[p]);
    const bak = p + '.bak';
    if (existsSync(bak)) unlinkSync(bak);
  }
}

function patch(p, fn) {
  writeFileSync(p, fn(readFileSync(p, 'utf8')));
}

function runNamed(name) {
  const tsx = join(WEB, 'node_modules/.bin/tsx');
  const r = spawnSync(
    tsx,
    ['--test', '--test-name-pattern', `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'lib/auth/vault-oauth-state-112.pgtest.ts'],
    { cwd: WEB, encoding: 'utf8', timeout: 180_000, env: process.env, maxBuffer: 1 << 24 },
  );
  const out = (r.stdout || '') + (r.stderr || '');
  const fail = /not ok \d+ -/.test(out) || r.status !== 0;
  const pass = /# pass 1/.test(out) && /# fail 0/.test(out);
  const fails = [...out.matchAll(/^\s*not ok \d+ - (.*)$/gm)].map((x) => x[1]).filter((n) => !n.startsWith('\\#112'));
  const errs = [...out.matchAll(/^\s+(?:error|message|actual|expected): (.*)$/gm)].slice(0, 8).map((x) => x[1].slice(0, 200));
  return { fail, pass, status: r.status, out, fails, errs };
}

const CONSUME_BLOCK = `    let consumed = false;
    try {
      consumed = await consumeOAuthNonce(nonce);
    } catch {
      return settingsRedirect('/settings?oauth_error=callback_failed');
    }
    if (!consumed) {
      return settingsRedirect('/settings?oauth_error=state_already_used');
    }
`;
const AFTER_TOKEN = `    const tokens: OAuthTokens = {`;

const mutants = [
  {
    id: 'M1a-exp-gt-not-gte',
    test: 'clock-injected: exactly at exp → state_expired; verification row unconsumed',
    apply: () => patch(statePath, (s) => s.replace('Math.floor(nowMs / 1000) >= parsed.exp', 'Math.floor(nowMs / 1000) > parsed.exp')),
  },
  {
    id: 'M1b-skip-exp',
    test: 'clock-injected: exactly at exp → state_expired; verification row unconsumed',
    apply: () => patch(statePath, (s) => s.replace(/if \(Math\.floor\(nowMs \/ 1000\) >= parsed\.exp\) return \{ ok: false, error: 'state_expired' \};/, '/* skip exp */')),
  },
  {
    id: 'M1c-skip-nonce-compare',
    test: 'missing/mismatched cookie deny; transfer to other browser deny; re-login same browser ok',
    apply: () => patch(statePath, (s) => s.replace(/if \(!sameNonce\(nonceCookie, parsed\.nonce\)\) return \{ ok: false, error: 'nonce_mismatch' \};/, '/* skip nonce */')),
  },
  {
    id: 'M1d-skip-company-equality',
    test: 'cross-company and archived agent denied before exchange',
    apply: () => patch(cbPath, (s) => s.replace(/if \(companyId !== company\.id\) \{\s*return settingsRedirect\('\/settings\?oauth_error=company_mismatch'\);\s*\}/s, '/* skip company */')),
  },
  {
    id: 'M1e-skip-agent-recheck',
    test: 'cross-company and archived agent denied before exchange',
    apply: () => patch(cbPath, (s) => s.replace(/if \(agentId\) \{[\s\S]*?agent_not_in_company[\s\S]*?\}\s*\}/, '/* skip agent recheck */')),
  },
  {
    id: 'M1f-skip-consume',
    test: 'sequential durable replay → state_already_used; total one exchange/write',
    apply: () => patch(cbPath, (s) => s.replace(/consumed = await consumeOAuthNonce\(nonce\);/, 'consumed = true; /* skip consume */')),
  },
  {
    id: 'M1h-consume-after-exchange-reorder',
    test: 'exchange failure after consume → same-state retry denied; fresh authorize ok',
    note: 'Real reorder: move consume block after token parse (Test X1).',
    apply: () =>
      patch(cbPath, (s) => {
        if (!s.includes(CONSUME_BLOCK)) throw new Error('CONSUME_BLOCK missing');
        if (!s.includes(AFTER_TOKEN)) throw new Error('AFTER_TOKEN missing');
        let out = s.replace(CONSUME_BLOCK, '');
        out = out.replace(AFTER_TOKEN, CONSUME_BLOCK + AFTER_TOKEN);
        if (out === s) throw new Error('reorder no-op');
        return out;
      }),
  },
  {
    id: 'M1i-allow-company-user-authorize',
    test: 'company_user without identity → 400 clear message; preserved vault row untouched; company scope still works',
    apply: () => patch(azPath, (s) => s.replace(/if \(validated\.scope === 'company_user' \|\| validated\.userId\) \{[\s\S]*?status: 400 \},\s*\);\s*\}/, '/* allow company_user */')),
  },
  {
    id: 'M1j-default-secret-fallback',
    test: 'missing secret authorize/callback fail closed',
    apply: () =>
      patch(statePath, (s) =>
        s.replace(
          /function oauthStateKey\(\): Buffer \| null \{\n  if \(isDefaultOrUnsetJwtSecret\(\)\) return null;\n  const secret = process\.env\[OAUTH_STATE_SECRET_ENV\]!\.trim\(\);\n  \/\/ key = secret, data = domain label \(S2\)\n  return createHmac\('sha256', secret\)\.update\(OAUTH_STATE_KEY_INFO\)\.digest\(\);\n\}/,
          `function oauthStateKey(): Buffer | null {\n  const secret = process.env[OAUTH_STATE_SECRET_ENV]?.trim() || 'change-me-in-production';\n  return createHmac('sha256', secret).update(OAUTH_STATE_KEY_INFO).digest();\n}`,
        ),
      ),
  },
  {
    id: 'M1k-raw-key-accepts-raw-forged',
    test: 'raw-secret forged state and wrong-length sig deny without exchange',
    apply: () =>
      patch(statePath, (s) =>
        s.replace(
          /return createHmac\('sha256', secret\)\.update\(OAUTH_STATE_KEY_INFO\)\.digest\(\);/,
          `return Buffer.from(secret, 'utf8'); /* raw key mutant */`,
        ),
      ),
  },
  {
    id: 'M1-skip-archived-authorize',
    test: 'cross-company and archived agent denied before exchange',
    apply: () => patch(azPath, (s) => s.replace("if (!agent || agent.status === 'archived')", 'if (!agent)')),
  },
  {
    id: 'M1-global-cookie-name',
    test: 'other company cookie untouched while company A rotates',
    apply: () =>
      patch(statePath, (s) =>
        s.replace(
          /export function oauthNonceCookieName\(companyId: string\): string \{\n  return `\$\{OAUTH_NONCE_COOKIE_PREFIX\}\$\{companyId\}`;\n\}/,
          `export function oauthNonceCookieName(_companyId: string): string {\n  return 'tourbillon_vault_oauth_nonce';\n}`,
        ),
      ),
  },
  {
    id: 'M1-unconditional-clear',
    test: 'response-order race: old success response has no clear; new cookie survives; new callback ok',
    apply: () =>
      patch(cbPath, (s) => {
        return s.replace(
          'export async function GET(req: NextRequest) {',
          `export async function GET(req: NextRequest) {\n  const __res = await (async () => {`,
        ).replace(
          /return settingsRedirect\(`\/settings\?connected=\$\{encodeURIComponent\(serverId\)\}`\);\n  \} catch \(error\) \{\n    console\.error\('Error in OAuth callback:', error\);\n    return settingsRedirect\('\/settings\?oauth_error=callback_failed'\);\n  \}\n\}/,
          `return settingsRedirect(\`/settings?connected=\${encodeURIComponent(serverId)}\`);\n  } catch (error) {\n    console.error('Error in OAuth callback:', error);\n    return settingsRedirect('/settings?oauth_error=callback_failed');\n  }\n  })();\n  __res.cookies.set('tourbillon_vault_oauth_nonce.company-a', '', { httpOnly: true, path: '/api/vault/oauth/callback', maxAge: 0 });\n  return __res;\n}`,
        );
      }),
  },
  {
    id: 'M-callback-skip-company-user',
    test: 'callback company_user signed state → user_scope_unsupported; no consume/exchange/write',
    apply: () =>
      patch(cbPath, (s) => {
        const find = "if (scope === 'company_user') {\n      return settingsRedirect(`/settings?oauth_error=${USER_SCOPE_UNSUPPORTED_ERROR}`);\n    }";
        if (!s.includes(find)) throw new Error('company_user refusal missing');
        return s.replace(find, '/* skip company_user refusal */');
      }),
  },
  {
    id: 'M-callback-agent-ignores-company',
    test: 'signed A-state naming agent B1 → agent_not_in_company; no consume/exchange/write',
    apply: () =>
      patch(cbPath, (s) => {
        const find = 'where: and(eq(agents.id, agentId), eq(agents.companyId, company.id)),';
        if (!s.includes(find)) throw new Error('agent company filter missing');
        return s.replace(find, 'where: eq(agents.id, agentId),');
      }),
  },
  {
    id: 'M-consume-wall-clock',
    test: 'consume uses shared clock: row expires when TB112_NOW_MS passes expiresAt',
    note: 'Soft S4/X11: consume must use oauthNowMs, not Date.now().',
    apply: () =>
      patch(storePath, (s) => {
        const find = `export async function consumeOAuthNonce(nonce: string): Promise<boolean> {
  const now = new Date(oauthNowMs());`;
        if (!s.includes(find)) throw new Error('consume clock missing');
        return s.replace(
          find,
          `export async function consumeOAuthNonce(nonce: string): Promise<boolean> {
  const now = new Date();`,
        );
      }),
  },
  {
    id: 'M-consume-drop-identifier',
    test: 'consume DELETE keeps identifier predicate; foreign-identifier same-hash row untouched',
    note: 'Soft S4 pin: without identifier predicate the foreign same-hash row is deleted too.',
    apply: () =>
      patch(storePath, (s) => {
        const find = `        eq(verification.identifier, OAUTH_NONCE_IDENTIFIER),
        eq(verification.value, hashNonce(nonce)),`;
        if (!s.includes(find)) throw new Error('identifier predicate missing');
        return s.replace(find, `        eq(verification.value, hashNonce(nonce)),`);
      }),
    // This mutant may SURVIVE the clock test; run against sequential replay which still passes.
    // Prefer a test that inserts a colliding foreign identifier — use sequential replay as RED if consume breaks.
    testOverride: null,
  },
];

// Soft: identifier-drop may SURVIVE; classified SOFT-SURVIVED below.

const results = [];
try {
  for (const m of mutants) {
    restoreAll();
    try {
      m.apply();
    } catch (e) {
      results.push({ id: m.id, status: 'APPLY_FAIL', detail: String(e), note: m.note });
      continue;
    }
    const r = runNamed(m.test);
    const ok = r.fail && !r.pass;
    const row = {
      id: m.id,
      status: ok ? 'DISCRIMINATES' : 'DID_NOT_RED',
      test: m.test,
      note: m.note,
      fails: r.fails,
      errs: r.errs,
      exit: r.status,
    };
    results.push(row);
    console.log(`### ${m.id}: ${row.status} test=${JSON.stringify(m.test)}`);
    if (r.fails.length) console.log(`    failing=${JSON.stringify(r.fails)}`);
    if (r.errs.length) console.log(`    ${r.errs.join('\n    ')}`);
  }
} finally {
  restoreAll();
}

results.push({
  id: 'M1g-non-atomic-select-delete',
  status: 'HARNESS-LIMITED',
  note: 'Deterministic interleave of SELECT-then-DELETE against real PG needs a seam inside consume; not installed. Concurrent DELETE…RETURNING coverage remains in the main suite.',
});

for (const p of tracked) {
  if (sha(p) !== origSha[p]) {
    console.error('RESTORE_FAIL', p);
    process.exit(3);
  }
  if (existsSync(p + '.bak')) unlinkSync(p + '.bak');
}

console.log(JSON.stringify(results, null, 2));
const disc = results.filter((r) => r.status === 'DISCRIMINATES').length;
const bad = results.filter((r) => r.status === 'DID_NOT_RED' || r.status === 'APPLY_FAIL').length;
console.log(`mutants: HEAD=${headSha} ${disc} discriminate, ${bad} problems, soft/limited=${results.length - disc - bad}`);
process.exit(bad ? 1 : 0);
