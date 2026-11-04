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

// --- NIT-1 (#335 review): VALUE-based scrub layer — the key sanitizer is identity on bare
// strings, so raw / unparseable-brace details must still not smuggle token-shaped values. ---

const RUN_TOKEN = 'pm_run_' + 'eyJzdWIiOiJwdmM6YWdlbnQifQ' + '.' + 'c2lnLWJsb2ItZm9yLXRoZS1ydW4tdG9rZW4';
const CHAT_TOKEN = 'pm_chat_' + 'eyJzdWIiOiJjaGF0In0' + '.' + 'YW5vdGhlci1zaWctYmxvYi1mb3ItY2hhdA';
const JWT = 'eyJhbGciOiJIUzI1NiJ9' + '.' + 'eyJzdWIiOiJwdmM6YWdlbnQifQ' + '.' + 'c2lnbmF0dXJlLXNlZ21lbnQtdmFsdWU';
const SK_KEY = 'sk-' + 'abc123DEF456ghi789JKL012';

test('NIT-1: token-shaped values in RAW (no-brace) details are scrubbed, essence survives', () => {
  const text = harnessErrorTextWithDetail(
    'Harness run failed',
    'command exit 1: CLI crashed while sending token=' + RUN_TOKEN + ' and chat=' + CHAT_TOKEN,
  );
  assert.match(text, /command exit 1/);
  assert.match(text, /CLI crashed while sending/, 'detail essence must survive');
  assert.doesNotMatch(text, /pm_run_/, 'run token must not reach errorText');
  assert.doesNotMatch(text, /pm_chat_/, 'chat token must not reach errorText');
  assert.match(text, /\[REDACTED-value\]/);
});

test('NIT-1: JWTs and sk- keys and Bearer values are scrubbed from raw text', () => {
  const text = harnessErrorTextWithDetail(
    'Harness run failed',
    'gateway 401: Authorization: Bearer ' + JWT + ' rejected; fallback key ' + SK_KEY + ' also failed',
  );
  assert.match(text, /gateway 401/);
  assert.match(text, /rejected/, 'essence survives');
  assert.doesNotMatch(text, /eyJhbGci/, 'JWT must not reach errorText');
  assert.doesNotMatch(text, /sk-abc123/, 'sk- key must not reach errorText');
  assert.match(text, /Bearer \[REDACTED-value\]/, 'the shape label survives, the value does not');
});

test('NIT-1: unparseable-brace details (the fail-open path) still get the value layer', () => {
  const text = harnessErrorTextWithDetail(
    'Harness run failed',
    'crashed at {token: ' + SK_KEY + ' (truncated output',
  );
  assert.match(text, /crashed at \{token:/);
  assert.doesNotMatch(text, /sk-abc123/);
});

test('NIT-1: JSON path keeps belt AND braces — value layer catches secrets under NON-sensitive keys', () => {
  const text = harnessErrorTextWithDetail(
    'Harness run failed',
    'jsonrpc -32000: {"message":"auth failed key=' + SK_KEY + '","code":-32000}',
  );
  assert.match(text, /auth failed key=/);
  assert.match(text, /"code":-32000/, 'non-secret JSON fields survive');
  assert.doesNotMatch(text, /sk-abc123/, 'secret under a NON-sensitive key must still be scrubbed');
});

test('NIT-1: false-positive guard — ordinary CLI stderr passes through UNTOUCHED', () => {
  const ordinary = [
    "Error: Cannot find module '/usr/lib/node_modules/hermes-cli/dist/cli.js'",
    '    at Module._resolveFilename (node:internal/modules/cjs/loader:1105:15)',
    'npm ERR! code ELIFECYCLE',
    'connect ECONNREFUSED 127.0.0.1:4000',
    'hint: check pm_2 config and /home/derek/.hermes/bin/hermes on PATH',
  ].join('\n');
  assert.equal(redactedHarnessErrorDetail(ordinary), ordinary, 'prose/paths/short pm_ words must survive intact');
});
