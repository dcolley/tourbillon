/**
 * Outbound host allow-list writes: both writers (company settings, agent runtimeConfig) refuse
 * bad input with a clear error before any database read or write. The DB URL points at a closed
 * port, so reaching the database would fail with a connection error instead.
 */
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgres://tool-egress-test:unused@127.0.0.1:1/unused';

let company: typeof import('./company');
let agents: typeof import('./agents');
let form: typeof import('./tool-egress-form');

before(async () => {
  company = await import('./company');
  agents = await import('./agents');
  form = await import('./tool-egress-form');
});

const BAD_INPUTS: Array<[string, { mode: unknown; entries: unknown }, RegExp]> = [
  ['entries not a list', { mode: 'list', entries: 'ok.example' }, /must be a list of hosts/],
  ['entries an object', { mode: 'list', entries: { hosts: ['ok.example'] } }, /must be a list of hosts/],
  ['non-string entry', { mode: 'list', entries: ['ok.example', 7] }, /must be a string/],
  ['URL entry', { mode: 'list', entries: ['https://bad.example/x'] }, /bad\.example.*not a URL/],
  ['IPv6 entry', { mode: 'list', entries: ['[2001:db8::1]'] }, /IPv6/],
  ['unknown mode', { mode: 'maybe', entries: [] }, /Mode must be/],
  ['missing mode', { mode: undefined, entries: [] }, /Mode must be/],
];

describe('tool egress allow-list: write paths validate before the database', () => {
  for (const [label, input, pattern] of BAD_INPUTS) {
    it(`company: refuses ${label}`, async () => {
      await assert.rejects(
        () => company.updateCompanyToolEgressAllowList('company-x', input),
        (err: unknown) => err instanceof Error && err.name === 'ToolEgressAllowListValidationError' && pattern.test(err.message),
      );
    });

    it(`agent: refuses ${label}`, async () => {
      await assert.rejects(
        () => agents.updateAgentToolEgressAllowList('agent-x', input),
        (err: unknown) => err instanceof agents.AgentValidationError && pattern.test(err.message),
      );
    });
  }
});

/** Settings-page posts go through parseToolEgressFormData before the writer (both pages). */
const BAD_POSTS: Array<[string, Record<string, string>]> = [
  ['missing mode', { toolEgressEntries: 'search.example.com' }],
  ['missing mode and entries', {}],
  ['unknown mode', { toolEgressMode: 'maybe', toolEgressEntries: 'search.example.com' }],
  ['empty mode', { toolEgressMode: '', toolEgressEntries: '' }],
  ['wrong-case mode', { toolEgressMode: 'OFF', toolEgressEntries: '' }],
];

describe('tool egress allow-list: settings form posts are refused, never cleared', () => {
  const post = (fields: Record<string, string>) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    return form.parseToolEgressFormData(fd);
  };

  for (const [label, fields] of BAD_POSTS) {
    it(`company settings page: refuses ${label}`, async () => {
      await assert.rejects(
        () => company.updateCompanyToolEgressAllowList('company-x', post(fields)),
        (err: unknown) => err instanceof Error && err.name === 'ToolEgressAllowListValidationError' && /Mode must be 'off' or 'list'/.test(err.message),
      );
    });

    it(`agent settings page: refuses ${label}`, async () => {
      await assert.rejects(
        () => agents.updateAgentToolEgressAllowList('agent-x', post(fields)),
        (err: unknown) => err instanceof agents.AgentValidationError && /Mode must be 'off' or 'list'/.test(err.message),
      );
    });
  }

  it('company settings page: refuses a wildcard over a public suffix', async () => {
    await assert.rejects(
      () => company.updateCompanyToolEgressAllowList('company-x', post({ toolEgressMode: 'list', toolEgressEntries: 'ok.example\n*.co.uk' })),
      (err: unknown) => err instanceof Error && /\*\.co\.uk: A wildcard cannot cover a whole public suffix/.test(err.message),
    );
  });

  it('agent settings page: refuses a wildcard under localhost', async () => {
    await assert.rejects(
      () => agents.updateAgentToolEgressAllowList('agent-x', post({ toolEgressMode: 'list', toolEgressEntries: '*.localhost' })),
      (err: unknown) => err instanceof agents.AgentValidationError && /localhost/.test(err.message),
    );
  });
});
