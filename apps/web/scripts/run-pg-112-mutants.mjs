#!/usr/bin/env node
/**
 * Per-control discriminating mutants for #112 (Test M1).
 * Each mutant patches product source, runs ONE named test expecting FAIL, restores.
 * Does NOT count as acceptance — only proves the suite catches the named defect.
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const WEB = join(ROOT, 'apps/web');
const statePath = join(WEB, 'lib/vault-oauth-state.ts');
const cbPath = join(WEB, 'app/api/vault/oauth/callback/route.ts');
const azPath = join(WEB, 'app/api/vault/oauth/authorize/route.ts');
const storePath = join(WEB, 'lib/vault-oauth-nonce-store.ts');

const url = new URL(process.env.DATABASE_URL ?? 'postgres://x@invalid/none');
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !url.pathname.slice(1).startsWith('tb112_')) {
  console.error('mutants: need loopback tb112_* DATABASE_URL');
  process.exit(2);
}

function backup(p) {
  copyFileSync(p, p + '.bak');
}
function restore(p) {
  if (existsSync(p + '.bak')) {
    copyFileSync(p + '.bak', p);
  }
}
function patch(p, fn) {
  backup(p);
  writeFileSync(p, fn(readFileSync(p, 'utf8')));
}

function runNamed(name) {
  const tsx = join(WEB, 'node_modules/.bin/tsx');
  const r = spawnSync(
    tsx,
    ['--test', '--test-name-pattern', `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'lib/auth/vault-oauth-state-112.pgtest.ts'],
    { cwd: WEB, encoding: 'utf8', timeout: 120_000, env: process.env },
  );
  const out = (r.stdout || '') + (r.stderr || '');
  const fail = /not ok \d+ -/.test(out) || r.status !== 0;
  const pass = /# pass 1/.test(out) && /# fail 0/.test(out);
  return { fail, pass, status: r.status, out };
}

const mutants = [
  {
    id: 'M1a-exp-gt-not-gte',
    test: 'clock-injected: exactly at exp → state_expired; verification row unconsumed',
    apply: () => patch(statePath, (s) => s.replace('Math.floor(nowMs / 1000) >= parsed.exp', 'Math.floor(nowMs / 1000) > parsed.exp')),
    expect: 'fail',
  },
  {
    id: 'M1b-skip-exp',
    test: 'clock-injected: exactly at exp → state_expired; verification row unconsumed',
    apply: () => patch(statePath, (s) => s.replace(/if \(Math\.floor\(nowMs \/ 1000\) >= parsed\.exp\) return \{ ok: false, error: 'state_expired' \};/, '/* skip exp */')),
    expect: 'fail',
  },
  {
    id: 'M1c-skip-nonce-compare',
    test: 'missing/mismatched cookie deny; transfer to other browser deny; re-login same browser ok',
    apply: () => patch(statePath, (s) => s.replace(/if \(!sameNonce\(nonceCookie, parsed\.nonce\)\) return \{ ok: false, error: 'nonce_mismatch' \};/, '/* skip nonce */')),
    expect: 'fail',
  },
  {
    id: 'M1d-skip-company-equality',
    test: 'cross-company and archived agent denied before exchange',
    apply: () => patch(cbPath, (s) => s.replace(/if \(companyId !== company\.id\) \{\s*return settingsRedirect\('\/settings\?oauth_error=company_mismatch'\);\s*\}/s, '/* skip company */')),
    expect: 'fail',
  },
  {
    id: 'M1e-skip-agent-recheck',
    test: 'cross-company and archived agent denied before exchange',
    apply: () => patch(cbPath, (s) => s.replace(/if \(agentId\) \{[\s\S]*?agent_not_in_company[\s\S]*?\}\s*\}/, '/* skip agent recheck */')),
    expect: 'fail',
  },
  {
    id: 'M1f-skip-consume',
    test: 'sequential durable replay → state_already_used; total one exchange/write',
    apply: () => patch(cbPath, (s) => s.replace(/consumed = await consumeOAuthNonce\(nonce\);/, 'consumed = true; /* skip consume */')),
    expect: 'fail',
  },
  {
    id: 'M1h-consume-after-exchange',
    test: 'exchange failure after consume → same-state retry denied; fresh authorize ok',
    apply: () => {
      // crude: comment note — reorder is large; patch consume to no-op and add consume after fetch success only via swapping blocks is hard.
      // Instead: make consume always true without deleting, so retry after exchange failure still "consumes" again → second exchange — RED on exchange count.
      patch(storePath, (s) =>
        s.replace(
          /export async function consumeOAuthNonce\(nonce: string\): Promise<boolean> \{[\s\S]*?return rows\.length > 0;\n\}/,
          `export async function consumeOAuthNonce(nonce: string): Promise<boolean> {\n  return true; /* non-consuming mutant */\n}`,
        ),
      );
    },
    expect: 'fail',
    note: 'Approximates consume-after-exchange / skip-durable-claim: retry after exchange failure can exchange again.',
  },
  {
    id: 'M1i-allow-company-user',
    test: 'company_user without identity → 400 clear message; preserved vault row untouched; company scope still works',
    apply: () => patch(azPath, (s) => s.replace(/if \(validated\.scope === 'company_user' \|\| validated\.userId\) \{[\s\S]*?status: 400 \},\s*\);\s*\}/, '/* allow company_user */')),
    expect: 'fail',
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
    expect: 'fail',
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
    expect: 'fail',
  },
  {
    id: 'M1-skip-archived-authorize',
    test: 'cross-company and archived agent denied before exchange',
    apply: () => patch(azPath, (s) => s.replace("if (!agent || agent.status === 'archived')", 'if (!agent)')),
    expect: 'fail',
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
    expect: 'fail',
  },
  {
    id: 'M1-unconditional-clear',
    test: 'response-order race: old success response has no clear; new cookie survives; new callback ok',
    apply: () =>
      patch(cbPath, (s) => {
        if (s.includes('clearNonceOnCallback')) return s;
        return s.replace(
          'export async function GET(req: NextRequest) {',
          `export async function GET(req: NextRequest) {\n  const __res = await (async () => {`,
        ).replace(
          /return settingsRedirect\(`\/settings\?connected=\$\{encodeURIComponent\(serverId\)\}`\);\n  \} catch \(error\) \{\n    console\.error\('Error in OAuth callback:', error\);\n    return settingsRedirect\('\/settings\?oauth_error=callback_failed'\);\n  \}\n\}/,
          `return settingsRedirect(\`/settings?connected=\${encodeURIComponent(serverId)}\`);\n  } catch (error) {\n    console.error('Error in OAuth callback:', error);\n    return settingsRedirect('/settings?oauth_error=callback_failed');\n  }\n  })();\n  // #133-style unconditional clear mutant\n  const { oauthNonceCookieName, oauthNonceCookieOptions } = await import('@/lib/vault-oauth-state');\n  __res.cookies.set('tourbillon_vault_oauth_nonce.company-a', '', { ...oauthNonceCookieOptions(req.headers), maxAge: 0 });\n  return __res;\n}`,
        );
      }),
    expect: 'fail',
    note: 'If structural patch fails to apply cleanly, marked SKIP below.',
  },
];

let bad = 0;
const results = [];
for (const m of mutants) {
  for (const f of [statePath, cbPath, azPath, storePath]) restore(f);
  try {
    m.apply();
  } catch (e) {
    results.push({ id: m.id, status: 'APPLY_FAIL', detail: String(e) });
    bad++;
    for (const f of [statePath, cbPath, azPath, storePath]) restore(f);
    continue;
  }
  const r = runNamed(m.test);
  const ok = m.expect === 'fail' ? r.fail && !r.pass : r.pass;
  results.push({ id: m.id, status: ok ? 'DISCRIMINATES' : 'DID_NOT_RED', test: m.test, note: m.note });
  if (!ok) bad++;
  for (const f of [statePath, cbPath, azPath, storePath]) restore(f);
}

// M1g harness-limited note
results.push({
  id: 'M1g-non-atomic-select-delete',
  status: 'HARNESS-LIMITED',
  note: 'Deterministic interleave of SELECT-then-DELETE against real PG needs a seam inside consume; not installed. Concurrent DELETE…RETURNING coverage remains in the main suite.',
});

console.log(JSON.stringify(results, null, 2));
console.log(`mutants: ${results.filter((r) => r.status === 'DISCRIMINATES').length} discriminate, ${bad} problems`);
process.exit(bad ? 1 : 0);
