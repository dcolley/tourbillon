/**
 * CONCIERGE-PARAMS S1 — #204 Soft B: pin the two thin DB-bound call sites that delegate to the
 * tested pure helpers.
 *
 * The helper tests (concierge-model.test.ts, company-utils.test.ts) cover buildChatControllerOptions
 * and mergeConciergeModelSettings themselves; what survived the #204 gates were mutations AT the
 * call sites: registry.ts passing `{ ...modelOpts, params: undefined }` and company.ts passing
 * `{ ...input, params: undefined }`. Both are one-line delegations, so (per the #204 ACCEPT) a
 * source-level text pin is the proportionate guard — same pattern as
 * lib/agent-code-execution-lan-copy.test.ts. No DB, no controller boot.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

describe('CONCIERGE-PARAMS S1 call sites (#204 Soft B)', () => {
  it('registry.ts hands buildChatControllerOptions the WHOLE modelOpts (mutant: {...modelOpts, params: undefined})', async () => {
    const source = await readFile(path.join(__dirname, 'registry.ts'), 'utf-8');
    assert.match(
      source,
      /buildChatControllerOptions\(\s*companyRow,\s*modelOpts\s*\)/,
      'getTourbillonChatController must pass the resolved modelOpts object through untouched — ' +
        'silently clearing params reverts the chat TokenLimiter/generation to provider-default sizing',
    );
    assert.ok(
      !/buildChatControllerOptions\([^)]*params:\s*undefined/.test(source),
      'no params: undefined at the buildChatControllerOptions call site',
    );
  });

  it('company.ts hands mergeConciergeModelSettings the WHOLE input (mutant: {...input, params: undefined})', async () => {
    const source = await readFile(path.join(__dirname, '../company.ts'), 'utf-8');
    assert.match(
      source,
      /mergeConciergeModelSettings\(\s*company\.settings,\s*input\s*\)/,
      'updateCompanyConciergeModel must persist the whole input — dropping params stores a ' +
        'paramless concierge pair that silently un-sizes every later chat run',
    );
    assert.ok(
      !/mergeConciergeModelSettings\([^)]*params:\s*undefined/.test(source),
      'no params: undefined at the mergeConciergeModelSettings call site',
    );
  });
});
