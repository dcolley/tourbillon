/**
 * #348 C2b/C2f + §2.2 — path allowlist unit tests.
 * With the flag ON only the agents surface is served; memory, tool-execute,
 * workflows, telemetry and every other Mastra family stays 404. Encoded and
 * traversal-shaped paths never re-match.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isStudioApiPathAllowed } from '@tourbillon/shared/mastra-studio';

const ID = '9f1c2b3a-0000-4000-8000-abcdef012345';

describe('#348 path allowlist (flag-on surface)', () => {
  it('C3/C2f: agents list, detail, tools, generate, stream are allowed', () => {
    assert.equal(isStudioApiPathAllowed('GET', 'agents'), true);
    assert.equal(isStudioApiPathAllowed('GET', 'agents/'), true);
    assert.equal(isStudioApiPathAllowed('GET', `agents/${ID}`), true);
    assert.equal(isStudioApiPathAllowed('GET', `agents/${ID}/tools`), true);
    assert.equal(isStudioApiPathAllowed('HEAD', 'agents'), true);
    assert.equal(isStudioApiPathAllowed('POST', `agents/${ID}/generate`), true);
    assert.equal(isStudioApiPathAllowed('POST', `agents/${ID}/stream`), true);
  });

  it('C2f: memory + tool-execute (both spellings) 404 even with the flag ON', () => {
    for (const p of [
      'memory',
      'memory/threads',
      `agents/${ID}/memory`,
      'tools',
      'tools/some-tool/execute',
      `agents/${ID}/tools/some-tool/execute`,
    ]) {
      for (const m of ['GET', 'POST']) {
        assert.equal(isStudioApiPathAllowed(m, p), false, `${m} ${p} must be 404 with flag on`);
      }
    }
  });

  it('C2f: workflows/telemetry/every-other-family 404 with the flag ON', () => {
    for (const p of [
      '', // mount root itself
      'workflows',
      'stored/workflows',
      'telemetry',
      'telemetry/traces',
      'knowledge',
      'vectors',
      'datasets',
      'experiments',
      'scores',
      'mcp',
      'logs',
      'v1/responses',
      'v1/conversations',
    ]) {
      assert.equal(isStudioApiPathAllowed('GET', p), false, `GET ${p} must be 404 with flag on`);
    }
  });

  it('write methods never allowed (mutant: flag-check only GET)', () => {
    assert.equal(isStudioApiPathAllowed('POST', 'agents'), false);
    assert.equal(isStudioApiPathAllowed('PUT', `agents/${ID}/generate`), false);
    assert.equal(isStudioApiPathAllowed('DELETE', 'agents'), false);
    assert.equal(isStudioApiPathAllowed('PATCH', `agents/${ID}/stream`), false);
    assert.equal(isStudioApiPathAllowed('POST', 'tools/execute'), false);
  });

  it('C4d defence-in-depth: percent-encoding, backslash, double-slash, traversal, case games never match', () => {
    for (const p of [
      'agents%2F' + ID,
      'agents/%2e%2e/agents',
      'agents/' + ID + '/tools/..%2fexecute',
      'Agents',
      'AGENTS',
      'agents\\..\\workflows',
      'agents//',
      'agents//' + ID,
      `agents/${ID}//tools`,
      `agents/../${ID}`,
      'agents/%2e',
      `agents/${ID}/generate/`,
      `agents/${ID}/generate/extra`,
    ]) {
      assert.equal(isStudioApiPathAllowed('GET', p), false, `GET ${p}`);
    }
    // The POST twins for generate/stream keep the trailing-slash tolerance only.
    assert.equal(isStudioApiPathAllowed('POST', `agents/${ID}/stream`), true);
  });

  it('agent id charset is pinned (no path-shaped ids slip through)', () => {
    assert.equal(isStudioApiPathAllowed('GET', 'agents/a b'), false);
    assert.equal(isStudioApiPathAllowed('GET', 'agents/..%2f..'), false);
    assert.equal(isStudioApiPathAllowed('POST', 'agents/-bad/generate'), false);
    assert.equal(isStudioApiPathAllowed('POST', `agents/${'x'.repeat(200)}/generate`), false);
  });
});
