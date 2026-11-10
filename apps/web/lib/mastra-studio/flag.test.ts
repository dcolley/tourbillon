/**
 * #348 C1 — MASTRA_API_ENABLED parser (unit).
 * On ONLY when the value is exactly 'true' (same rule as OBSERVABILITY_ENABLED).
 * Mutant guards per C1a-f: an `!== 'false'`, `Boolean(env...)`, case-insensitive,
 * truthy-'0' or alias-accepting parse must turn one of these red.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isMastraStudioApiEnabled } from '@tourbillon/shared/mastra-studio';

describe('#348 C1 MASTRA_API_ENABLED parser', () => {
  it('C1a: unset is OFF', () => {
    assert.equal(isMastraStudioApiEnabled({}), false);
  });

  it('C1b: empty string is OFF', () => {
    assert.equal(isMastraStudioApiEnabled({ MASTRA_API_ENABLED: '' }), false);
  });

  it('C1c: false is OFF', () => {
    assert.equal(isMastraStudioApiEnabled({ MASTRA_API_ENABLED: 'false' }), false);
  });

  it('C1d: 0 is OFF', () => {
    assert.equal(isMastraStudioApiEnabled({ MASTRA_API_ENABLED: '0' }), false);
  });

  it('C1e: typos and aliases are OFF (no case-insensitive / starts-with / 1 / yes parse)', () => {
    for (const value of ['ture', 'yes', 'on', 'TRUE', 'True', '1', 't', 'tr ue', ' true', 'true ']) {
      assert.equal(
        isMastraStudioApiEnabled({ MASTRA_API_ENABLED: value }),
        false,
        `value ${JSON.stringify(value)} must NOT enable the API`,
      );
    }
  });

  it('C1f: exactly true is ON', () => {
    assert.equal(isMastraStudioApiEnabled({ MASTRA_API_ENABLED: 'true' }), true);
  });
});
