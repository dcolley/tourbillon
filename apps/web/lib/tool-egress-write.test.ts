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

before(async () => {
  company = await import('./company');
  agents = await import('./agents');
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
