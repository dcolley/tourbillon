/**
 * Test fixture (#130 B3): the real Drizzle repo over a fake postgres client that serves one
 * company's vault rows, agent runtime configs and provider registry rows, so secret loading
 * (including vault decryption) runs for real. All keys and values are dummies.
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import { encryptCredential } from '@tourbillon/shared/vault-encryption';
import type { ApprovalDetailRepo } from './approval-detail';
import { createApprovalDetailRepo } from './approval-detail-repo';
import { PLANTED, plantedRepo } from './approval-detail-secrets.fixture';

/** Dummy 32-byte keys (hex). */
export const DUMMY_VAULT_KEY = '11'.repeat(32);
export const OTHER_DUMMY_VAULT_KEY = '22'.repeat(32);

export interface SecretRows {
  vault: Array<{ id: string; encryptedValue: string }>;
  agents: Array<{ runtimeConfig: unknown }>;
  providers: Array<{ apiKey: string | null; headers: Record<string, string> | null; baseURL: string }>;
}

/** Fake postgres-js client: rows by table, in the column order the repo selects. */
export function fakeSecretDb(rows: SecretRows) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    options: { parsers: {}, serializers: {} },
    unsafe(sql: string, params: unknown[]) {
      calls.push({ sql, params });
      let out: unknown[][] = [];
      if (/from "vault_secrets"/.test(sql)) out = rows.vault.map((r) => [r.id, r.encryptedValue]);
      else if (/from "agents"/.test(sql)) out = rows.agents.map((r) => [r.runtimeConfig]);
      else if (/from "llm_providers"/.test(sql)) out = rows.providers.map((r) => [r.apiKey, r.headers, r.baseURL]);
      const p = Promise.resolve(out) as unknown as Promise<unknown[]> & { values: () => Promise<unknown[]> };
      p.values = () => Promise.resolve(out);
      return p;
    },
  };
  return { db: drizzle(client as never), calls };
}

/** Run `fn` with VAULT_ENCRYPTION_KEY set to `key` (or unset for null), restoring it after. */
export async function withVaultKey<T>(key: string | null, fn: () => T | Promise<T>): Promise<T> {
  const env = process.env as Record<string, string | undefined>;
  const prev = env.VAULT_ENCRYPTION_KEY;
  if (key === null) delete env.VAULT_ENCRYPTION_KEY;
  else env.VAULT_ENCRYPTION_KEY = key;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete env.VAULT_ENCRYPTION_KEY;
    else env.VAULT_ENCRYPTION_KEY = prev;
  }
}

/** Planted values that only the vault knows (the planted approval echoes each of them). */
export const VAULT_ONLY_VALUES = [
  PLANTED.vault,
  PLANTED.title,
  PLANTED.historyNote,
  PLANTED.issueTitle,
  PLANTED.decisionNote,
  PLANTED.relatedVault,
];

/**
 * Vault rows (encrypted with DUMMY_VAULT_KEY) holding VAULT_ONLY_VALUES, one of them as OAuth
 * tokens, plus one provider row; `corrupt` adds a row that never decrypts.
 */
export async function plantedSecretRows(opts: { corrupt?: boolean } = {}): Promise<SecretRows> {
  const [vault, title, historyNote, issueTitle, decisionNote, relatedVault] = VAULT_ONLY_VALUES;
  const vaultRows = await withVaultKey(DUMMY_VAULT_KEY, () => [
    { id: 'vault-row-1', encryptedValue: encryptCredential(vault) },
    { id: 'vault-row-2', encryptedValue: encryptCredential({ accessToken: title, refreshToken: historyNote }) },
    { id: 'vault-row-3', encryptedValue: encryptCredential(issueTitle) },
    { id: 'vault-row-4', encryptedValue: encryptCredential(decisionNote) },
    { id: 'vault-row-5', encryptedValue: encryptCredential(relatedVault) },
  ]);
  if (opts.corrupt) vaultRows.push({ id: 'vault-row-bad', encryptedValue: 'bm90LWEtY2lwaGVydGV4dC1hdC1hbGwtMDAwMDAwMDAwMDAwMDAwMA==' });
  return {
    vault: vaultRows,
    agents: [],
    providers: [{ apiKey: PLANTED.provider, headers: null, baseURL: 'https://llm.example.test/v1' }],
  };
}

/** The planted approval, with secret values loaded by the real repo from `rows`. */
export function vaultBackedRepo(rows: SecretRows): ApprovalDetailRepo {
  const real = createApprovalDetailRepo(fakeSecretDb(rows).db as never);
  return { ...plantedRepo(), getSecretValues: real.getSecretValues };
}

/** Collect console.warn/error output while `fn` runs. */
export async function captureLogs<T>(fn: () => Promise<T>): Promise<{ result: T; logs: string }> {
  const lines: string[] = [];
  const orig = { warn: console.warn, error: console.error };
  const grab = (...args: unknown[]) => lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  console.warn = grab;
  console.error = grab;
  try {
    const result = await fn();
    return { result, logs: lines.join('\n') };
  } finally {
    console.warn = orig.warn;
    console.error = orig.error;
  }
}
