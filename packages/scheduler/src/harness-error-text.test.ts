/**
 * S331-4 (#331): heartbeat_runs.errorText must carry the adapter's failure DETAIL (exit code /
 * HTTP status / JSON-RPC message), sanitized via the vault log sanitizer and capped.
 *
 * Unit layer for harness-error-text.ts; the end-to-end layer (fake adapter failure → persisted
 * row) lives in wake-runner-hermes.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HARNESS_ERROR_TEXT_CAP,
  harnessErrorTextWithDetail,
  redactedHarnessErrorDetail,
} from './harness-error-text';

const CANARY = 'pm_' + 'su' + 'p3r' + 'ct-v4l-1f'; // fake; built split so no redaction pipeline ever mangles it

test('S331-4: detail is appended to the base sentence, verbatim when it carries no JSON payload', () => {
  assert.equal(
    harnessErrorTextWithDetail('Harness run failed', 'command exit 7: boom in gateway'),
    'Harness run failed: command exit 7: boom in gateway',
  );
  assert.equal(
    harnessErrorTextWithDetail('Harness run failed', '  command exit 7  '),
    'Harness run failed: command exit 7',
  );
  assert.equal(
    harnessErrorTextWithDetail('hermes gateway HTTP 503', 'hermes gateway HTTP 503'),
    'hermes gateway HTTP 503: hermes gateway HTTP 503',
  );
});

test('S331-4: absent/blank detail keeps the STATIC base string (no trailing colon)', () => {
  assert.equal(harnessErrorTextWithDetail('Harness run failed', undefined), 'Harness run failed');
  assert.equal(harnessErrorTextWithDetail('Harness run failed', null), 'Harness run failed');
  assert.equal(harnessErrorTextWithDetail('Harness run failed', '   '), 'Harness run failed');
  assert.equal(redactedHarnessErrorDetail(undefined), undefined);
  assert.equal(redactedHarnessErrorDetail(''), undefined);
});

test('S331-4: a secret-looking value under a sensitive key in the detail JSON is REDACTED; the essence survives', () => {
  const detail = 'command exit 1: {"stderr":"gateway crashed during runTask","token":"' + CANARY + '"}';
  const text = harnessErrorTextWithDetail('Harness run failed', detail);
  assert.match(text, /command exit 1/);
  assert.match(text, /gateway crashed during runTask/, 'detail essence must survive');
  assert.doesNotMatch(text, new RegExp(CANARY), 'secret value must not reach errorText');
  assert.match(text, /\[REDACTED\]/);
});

test('S331-4: PRE-EXISTING sanitizer quirk pinned — key match is a substring, so inputTokens is also redacted', () => {
  // NOT a bug to fix here: sanitizeForLogging matches keys by substring, so a legitimate
  // usage field vanishes too. Pinned so a future sanitizer tightening is a deliberate change.
  const detail = 'jsonrpc -32000: {"message":"bad usage","inputTokens":42}';
  const text = harnessErrorTextWithDetail('Harness run failed', detail);
  assert.match(text, /bad usage/);
  assert.doesNotMatch(text, /"inputTokens":42/);
  assert.match(text, /"inputTokens":"\[REDACTED\]"/);
});

test('S331-4: non-JSON / unparseable-brace details pass through verbatim (shape fail-open, length bounded)', () => {
  assert.equal(
    harnessErrorTextWithDetail('Harness run failed', 'command exit 1: {not json at all'),
    'Harness run failed: command exit 1: {not json at all',
  );
  assert.equal(
    redactedHarnessErrorDetail('plain text cause, no braces'),
    'plain text cause, no braces',
  );
});

test('S331-4: composed errorText respects the existing errorText cap', () => {
  assert.equal(HARNESS_ERROR_TEXT_CAP, 2000, 'cap matches the wake-runner errorText convention');
  const long = 'command exit 1: ' + 'x'.repeat(5000);
  const text = harnessErrorTextWithDetail('Harness run failed', long);
  assert.equal(text.length, HARNESS_ERROR_TEXT_CAP);
  assert.ok(text.startsWith('Harness run failed: command exit 1'));
});
