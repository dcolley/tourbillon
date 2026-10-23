import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  markEnabledForCompany,
  providersForCompanyPicker,
  PROVIDER_OFF_SUFFIX,
  setProviderEnabledForCompanyRequest,
} from './company-llm-providers';

const providers = [
  { id: 'a', name: 'Alpha' },
  { id: 'b', name: 'Bravo' },
  { id: 'c', name: 'Charlie' },
];

describe('markEnabledForCompany', () => {
  it('no switches → every provider on (default-enabled)', () => {
    assert.deepEqual(
      markEnabledForCompany(providers, new Set()).map((p) => p.enabledForCompany),
      [true, true, true],
    );
  });
  it('switched-off ids are marked off', () => {
    assert.deepEqual(
      markEnabledForCompany(providers, new Set(['b'])).map((p) => [p.id, p.enabledForCompany]),
      [['a', true], ['b', false], ['c', true]],
    );
  });
});

describe('providersForCompanyPicker', () => {
  const marked = markEnabledForCompany(providers, new Set(['b', 'c']));
  it('hides providers switched off for the company', () => {
    assert.deepEqual(providersForCompanyPicker(marked).map((p) => p.id), ['a']);
  });
  it('keeps current selections, labelled as off', () => {
    const list = providersForCompanyPicker(marked, ['b', null, undefined]);
    assert.deepEqual(list.map((p) => p.id), ['a', 'b']);
    assert.equal(list[1].name, `Bravo${PROVIDER_OFF_SUFFIX}`);
    assert.equal(list[0].name, 'Alpha');
  });
  it('accepts a single id', () => {
    assert.deepEqual(providersForCompanyPicker(marked, 'c').map((p) => p.id), ['a', 'c']);
  });
});

describe('setProviderEnabledForCompanyRequest', () => {
  it('PATCHes the company route with { enabled }', async () => {
    let seen: { url: string; init?: RequestInit } | null = null;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen = { url, init };
      return Response.json({ providerId: 'p 1', companyId: 'co-a', enabledForCompany: false });
    }) as unknown as typeof fetch;
    const res = await setProviderEnabledForCompanyRequest('co-a', 'p 1', false, fetchImpl);
    assert.deepEqual(res, { providerId: 'p 1', companyId: 'co-a', enabledForCompany: false });
    assert.equal(seen!.url, '/api/companies/co-a/llm-providers/p%201');
    assert.equal(seen!.init?.method, 'PATCH');
    assert.equal(seen!.init?.body, JSON.stringify({ enabled: false }));
  });
  it('throws the server error message', async () => {
    const fetchImpl = (async () =>
      Response.json({ error: 'Forbidden: board only' }, { status: 403 })) as unknown as typeof fetch;
    await assert.rejects(
      setProviderEnabledForCompanyRequest('co-a', 'p', true, fetchImpl),
      /Forbidden: board only/,
    );
  });
});
