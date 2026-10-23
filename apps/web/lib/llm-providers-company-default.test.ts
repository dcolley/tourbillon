/**
 * PRV-1: the provider a new agent starts on (company default) and the provider an agent
 * effectively uses honour the company's switches. Real lib/llm-providers.ts; @tourbillon/db mocked.
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

type ProviderRow = {
  id: string;
  name: string;
  type: string;
  baseURL: string;
  apiKey: string | null;
  headers: Record<string, string>;
  apiMode: string | null;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
};

const row = (id: string, name: string, isDefault = false): ProviderRow => ({
  id,
  name,
  type: 'openai-compatible',
  baseURL: `http://${id}.test/v1`,
  apiKey: null,
  headers: {},
  apiMode: null,
  isDefault,
  createdAt: new Date(0),
  updatedAt: new Date(0),
});

let providers: ProviderRow[];
let disabled: Set<string>;

describe('PRV-1 company default provider', () => {
  let lib: typeof import('./llm-providers');

  before(async () => {
    const Module = require('module');
    const originalRequire = Module.prototype.require;
    Module.prototype.require = function (this: { filename?: string }, id: string) {
      if (id === '@tourbillon/db' && this.filename?.endsWith('/lib/llm-providers.ts')) {
        return {
          db: {},
          agents: {},
          llmProviders: {},
          listLlmProviderRows: async () => providers,
          getDefaultLlmProviderRow: async () => providers.find((p) => p.isDefault) ?? null,
          getLlmProviderRowById: async (pid: string) => providers.find((p) => p.id === pid) ?? null,
          resolveCompanyLlmProviderRow: async (_companyId: string, requested: string | null) => {
            if (!requested) return { row: null, fallbackFrom: null };
            const asked = providers.find((p) => p.id === requested);
            if (!asked) return { row: null, fallbackFrom: null };
            if (!disabled.has(requested)) return { row: asked, fallbackFrom: null };
            const on = providers.filter((p) => !disabled.has(p.id));
            const fb = on.find((p) => p.isDefault) ?? on[0];
            if (!fb) {
              const err = new Error('No LLM provider is enabled for this company.');
              err.name = 'NoEnabledLlmProviderError';
              throw err;
            }
            return { row: fb, fallbackFrom: asked };
          },
        };
      }
      return originalRequire.apply(this, arguments as unknown as [string]);
    };
    lib = await import('./llm-providers');
    Module.prototype.require = originalRequire;
  });

  beforeEach(() => {
    providers = [row('p-default', 'Default gateway', true), row('p-local', 'Local studio')];
    disabled = new Set();
  });

  it('new agents start on the registry default when it is on for the company', async () => {
    assert.equal((await lib.getCompanyDefaultLlmProviderRecord('co-a'))?.id, 'p-default');
  });

  it('new agents start on the company fallback when the registry default is off', async () => {
    disabled = new Set(['p-default']);
    assert.equal((await lib.getCompanyDefaultLlmProviderRecord('co-a'))?.id, 'p-local');
  });

  it('nothing on for the company → NoEnabledLlmProviderError', async () => {
    disabled = new Set(['p-default', 'p-local']);
    await assert.rejects(() => lib.getCompanyDefaultLlmProviderRecord('co-a'), {
      name: 'NoEnabledLlmProviderError',
    });
  });

  it('no registry providers keeps the env path (null)', async () => {
    providers = [];
    assert.equal(await lib.getCompanyDefaultLlmProviderRecord('co-a'), null);
    assert.equal(await lib.effectiveLlmProviderIdForCompany('co-a', null), null);
  });

  it('effective provider: own provider when on, company default when off', async () => {
    assert.equal(await lib.effectiveLlmProviderIdForCompany('co-a', 'p-local'), 'p-local');
    disabled = new Set(['p-local']);
    assert.equal(await lib.effectiveLlmProviderIdForCompany('co-a', 'p-local'), 'p-default');
    assert.equal(await lib.effectiveLlmProviderIdForCompany('co-a', null), 'p-default');
  });
});
