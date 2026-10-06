import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyCodeExecutionOverrides,
  buildCodeExecutionActivityDetails,
  parseCodeExecutionFormData,
} from './code-execution-config';

function form(entries: Record<string, string | string[]>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    if (Array.isArray(value)) {
      for (const item of value) data.append(key, item);
    } else {
      data.set(key, value);
    }
  }
  return data;
}

describe('parseCodeExecutionFormData', () => {
  it('Off mode unsets the allow-list and keeps allowNetwork', () => {
    const parsed = parseCodeExecutionFormData(
      form({
        agentId: 'ag_1',
        urlKey: 'cto',
        runtimeType: 'agent',
        codeExecutionEnabled: 'on',
        codeExecutionAllowNetwork: 'on',
        egressAllowListMode: 'off',
        egressAllowList: ['example.com'],
      }),
    );
    assert.equal(parsed.input.egressAllowList, null);
    assert.equal(parsed.input.allowNetwork, true);
  });

  it('Empty list mode saves [] and does not overwrite allowNetwork', () => {
    const parsed = parseCodeExecutionFormData(
      form({
        agentId: 'ag_1',
        urlKey: 'cto',
        runtimeType: 'harness',
        egressAllowListMode: 'empty',
        codeExecutionAllowNetwork: 'on',
      }),
    );
    assert.deepEqual(parsed.input.egressAllowList, []);
    assert.equal(parsed.input.allowNetwork, undefined);
    assert.equal(parsed.input.runtimeType, 'harness');
  });

  it('List mode sanitizes entries through the existing update input', () => {
    const parsed = parseCodeExecutionFormData(
      form({
        agentId: 'ag_1',
        urlKey: 'cto',
        runtimeType: 'agent',
        codeExecutionEnabled: 'on',
        egressAllowListMode: 'list',
        egressAllowList: [' API.Example.com ', '10.0.0.0/8'],
      }),
    );
    assert.deepEqual(parsed.input.egressAllowList, ['api.example.com', '10.0.0.0/8']);
    assert.equal(parsed.input.allowNetwork, undefined);
  });

  it('rejects invalid list entries before save', () => {
    assert.throws(
      () =>
        parseCodeExecutionFormData(
          form({
            agentId: 'ag_1',
            urlKey: 'cto',
            runtimeType: 'agent',
            egressAllowListMode: 'list',
            egressAllowList: ['https://example.com/path'],
          }),
        ),
      /URL/,
    );
  });
});

describe('applyCodeExecutionOverrides', () => {
  it('unsets the allow-list in Off mode and preserves other overrides', () => {
    const next = applyCodeExecutionOverrides(
      { isolation: 'bwrap', allowNetwork: true, egressAllowList: ['example.com'] },
      { egressAllowList: null, allowNetwork: false },
    );
    assert.deepEqual(next, { isolation: 'bwrap', allowNetwork: false });
    assert.equal(next?.egressAllowList, undefined);
  });

  it('persists an empty list as no network', () => {
    const next = applyCodeExecutionOverrides({ allowNetwork: true }, { egressAllowList: [] });
    assert.deepEqual(next?.egressAllowList, []);
    assert.equal(next?.allowNetwork, true);
  });

  it('persists a sanitized list of entries', () => {
    const next = applyCodeExecutionOverrides(undefined, {
      isolation: 'bwrap',
      egressAllowList: ['*.example.com', '1.2.3.4'],
    });
    assert.deepEqual(next, {
      isolation: 'bwrap',
      egressAllowList: ['*.example.com', '1.2.3.4'],
    });
  });

  it('rejects invalid entries on the update path', () => {
    assert.throws(
      () => applyCodeExecutionOverrides(undefined, { egressAllowList: ['*', 'example.com'] }),
      /Bare \*/,
    );
    assert.throws(
      () => applyCodeExecutionOverrides(undefined, { egressAllowList: ['::1'] }),
      /IPv6/,
    );
  });

  it('clears all per-agent overrides including the allow-list', () => {
    const next = applyCodeExecutionOverrides(
      { isolation: 'none', allowNetwork: true, egressAllowList: ['example.com'] },
      { clearCodeExecutionOverrides: true, egressAllowList: ['example.com'] },
    );
    assert.equal(next, undefined);
  });
});

describe('buildCodeExecutionActivityDetails', () => {
  it('records the resolved allow-list for the activity entry', () => {
    const details = buildCodeExecutionActivityDetails({
      runtimeType: 'agent',
      codeExecutionEnabled: true,
      before: { allowNetwork: true },
      after: { allowNetwork: true, egressAllowList: ['api.example.com'] },
    });
    assert.equal(details.runtimeType, 'agent');
    assert.deepEqual(details.egressAllowList, ['api.example.com']);
    assert.deepEqual((details.after as { egressAllowList?: string[] }).egressAllowList, [
      'api.example.com',
    ]);
  });

  it('records Off as a null allow-list', () => {
    const details = buildCodeExecutionActivityDetails({
      runtimeType: 'agent',
      codeExecutionEnabled: true,
      before: { egressAllowList: [] },
      after: { allowNetwork: false },
    });
    assert.equal(details.egressAllowList, null);
  });
});
