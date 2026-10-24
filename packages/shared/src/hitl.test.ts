/**
 * APR-2: the shared hitl v0 zod schemas against the published spec fixtures (hitl-spec c0cf379,
 * vendored under __tests__/fixtures/hitl-spec-v0): valid examples parse and round-trip, invalid
 * fixtures are refused, hash vectors and example signatures recompute.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  effectiveReasonRequired,
  hitlReasonRequiredFor,
  parseHitlEvent,
  parseHitlRequest,
  parseHitlRequestForIngest,
  parseHitlResponse,
  validateHitlAnswer,
  type HitlRequest,
} from './hitl';
import { argsHash, hitlEventHash, sha256b64url, verifyHitlEventChain } from './hitl-hash';
import { jcs } from './jcs';

const FIX = join(__dirname, '__tests__', 'fixtures', 'hitl-spec-v0');
const read = (rel: string) => JSON.parse(readFileSync(join(FIX, rel), 'utf8'));
const list = (dir: string) =>
  readdirSync(join(FIX, dir))
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => `${dir}/${f}`);

const parsers = { requests: parseHitlRequest, responses: parseHitlResponse, events: parseHitlEvent } as const;

describe('hitl v0 spec fixtures (c0cf379)', () => {
  for (const dir of Object.keys(parsers) as Array<keyof typeof parsers>) {
    for (const file of list(`examples/${dir}`)) {
      it(`${file} parses and round-trips unchanged`, () => {
        const raw = read(file);
        const r = parsers[dir](raw);
        assert.ok(r.ok, JSON.stringify(!r.ok && r.errors));
        assert.deepEqual(r.value, raw);
        assert.equal(jcs(JSON.parse(JSON.stringify(r.value))), jcs(raw));
        const again = parsers[dir](JSON.parse(JSON.stringify(r.value)));
        assert.ok(again.ok);
        assert.deepEqual(again.value, raw);
      });
    }
    for (const file of list(`invalid/${dir}`)) {
      it(`${file} is refused with a field error`, () => {
        const r = parsers[dir](read(file));
        assert.equal(r.ok, false);
        assert.ok(!r.ok && r.errors.length > 0 && r.errors.every((e) => typeof e.field === 'string' && e.message));
      });
    }
  }

  it('invalid fixtures name the failing field', () => {
    const fields = (file: string, dir: keyof typeof parsers) => {
      const r = parsers[dir](read(file));
      return r.ok ? [] : r.errors.map((e) => e.field);
    };
    assert.ok(fields('invalid/requests/question-without-question-mark.json', 'requests').includes('/question'));
    assert.ok(fields('invalid/requests/http-link.json', 'requests').includes('/context/links/0/url'));
    assert.ok(fields('invalid/requests/on-expiry-auto-approve.json', 'requests').includes('/onExpiry'));
    const renamed = parsers.responses(read('invalid/responses/answer-field-renamed.json'));
    assert.ok(!renamed.ok);
    assert.ok(!renamed.ok && renamed.errors.some((e) => e.field === '/answer' && /unknown key/.test(e.message) && e.hint));
    assert.ok(fields('invalid/events/scroll-from-host.json', 'events').includes('/source'));
  });

  it('args-hash vectors recompute (JCS + b64url SHA-256)', () => {
    for (const v of read('examples/vectors/args-hash.json')) {
      assert.equal(jcs(v.args), v.jcs);
      assert.equal(argsHash(v.args), v.argsHash);
      assert.equal(sha256b64url(v.jcs), v.argsHash);
    }
  });

  it('event-chain vector links and every hash recomputes', () => {
    const chain = read('examples/vectors/event-chain.json');
    for (const e of chain) {
      assert.ok(parseHitlEvent(e).ok);
      assert.equal(hitlEventHash(e), e.hash);
    }
    assert.ok(verifyHitlEventChain(chain));
    const tampered = chain.map((e: Record<string, unknown>) => ({ ...e }));
    tampered[0].at = '2026-10-24T14:20:04Z';
    assert.equal(verifyHitlEventChain(tampered), false);
  });

  it('example response signatures verify over JCS (signature removed)', () => {
    const keys = read('examples/keys/hitl-keys.json').keys as Array<Record<string, string>>;
    for (const file of list('examples/responses')) {
      const resp = read(file);
      const { signature, ...unsigned } = resp;
      const jwk = keys.find((k) => k.kid === signature.kid)!;
      const key = createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, format: 'jwk' });
      assert.ok(verify(null, Buffer.from(jcs(unsigned)), key, Buffer.from(signature.sig, 'base64url')), file);
    }
  });
});

const binary = (over: Record<string, unknown> = {}) => ({
  spec: 'hitl/request/v0',
  question: 'Ship it?',
  answerType: 'binary',
  options: [
    { value: 'approve', label: 'Ship' },
    { value: 'reject', label: 'Hold' },
  ],
  requester: { agentId: 'agent-1' },
  ...over,
});
const errs = (input: unknown) => {
  const r = parseHitlRequest(input);
  return r.ok ? [] : r.errors;
};
const fieldsOf = (input: unknown) => errs(input).map((e) => e.field);

describe('hitl request rules beyond the JSON Schema', () => {
  it('refuses unknown keys at any depth, but accepts reverse-DNS _meta', () => {
    assert.deepEqual(fieldsOf(binary({ title: 'x' })), ['/title']);
    assert.deepEqual(fieldsOf(binary({ requester: { agentId: 'a', role: 'ceo' } })), ['/requester/role']);
    assert.deepEqual(
      fieldsOf(binary({ options: [{ value: 'approve', label: 'A', colour: 'red' }, { value: 'reject', label: 'R' }] })),
      ['/options/0/colour'],
    );
    assert.ok(parseHitlRequest(binary({ _meta: { 'net.hitly/trace': { a: 1 }, 'com.example/x': 2 } })).ok);
    assert.ok(fieldsOf(binary({ _meta: { trace: 1 } })).some((f) => f.startsWith('/_meta')));
  });

  it('binary option values are fixed; reasonRequired defaults to reject', () => {
    assert.ok(fieldsOf(binary({ options: [{ value: 'yes', label: 'Y' }, { value: 'no', label: 'N' }] })).includes('/options'));
    const r = parseHitlRequest(binary());
    assert.ok(r.ok);
    assert.deepEqual(effectiveReasonRequired(r.value), ['reject']);
    assert.equal(hitlReasonRequiredFor(r.value, 'reject'), true);
    assert.equal(hitlReasonRequiredFor(r.value, 'approve'), false);
  });

  it('onExpiry is absent or "expire"; risk.level is low|medium|high|critical', () => {
    assert.ok(parseHitlRequest(binary({ onExpiry: 'expire' })).ok);
    assert.ok(fieldsOf(binary({ onExpiry: 'reject' })).includes('/onExpiry'));
    assert.ok(parseHitlRequest(binary({ risk: { level: 'critical' } })).ok);
    assert.ok(fieldsOf(binary({ risk: { level: 'severe' } })).includes('/risk/level'));
  });

  it('secret requests carry encryption and no default, recommended or reasonRequired', () => {
    const secret = {
      spec: 'hitl/request/v0',
      question: 'What is the key?',
      answerType: 'secret',
      encryption: { publicKey: 'aUe06yud5-sO8Pp2F300oD5PJQpZE_muFRiArmDNsi8', alg: 'HPKE-X25519-SHA256-AES128GCM' },
      requester: { agentId: 'a' },
    };
    assert.ok(parseHitlRequest(secret).ok);
    assert.ok(fieldsOf({ ...secret, default: 'x' }).includes('/default'));
    assert.ok(fieldsOf({ ...secret, recommended: { value: 'x', reason: 'r' } }).includes('/recommended'));
    assert.ok(fieldsOf({ ...secret, reasonRequired: ['x'] }).includes('/reasonRequired'));
    assert.ok(fieldsOf({ ...secret, encryption: undefined }).includes('/encryption'));
  });

  it('default, recommended and reasonRequired must be valid answers; refs unique; bounds consistent', () => {
    assert.ok(fieldsOf(binary({ default: 'maybe' })).includes('/default'));
    const num = { spec: 'hitl/request/v0', question: 'How much?', answerType: 'number', requester: { agentId: 'a' } };
    assert.ok(fieldsOf({ ...num, bounds: { min: 10, max: 1 } }).includes('/bounds/min'));
    assert.ok(fieldsOf({ ...num, bounds: { step: 0 } }).includes('/bounds/step'));
    assert.ok(fieldsOf({ ...num, bounds: { min: 0, max: 100, step: 10 }, recommended: { value: 15, reason: 'r' } }).includes('/recommended/value'));
    assert.ok(fieldsOf({ ...num, options: [{ value: 'a', label: 'A' }] }).includes('/options'));
    const link = (ref: string) => ({ ref, url: 'https://example.com/a', label: 'A' });
    assert.ok(fieldsOf(binary({ context: { links: [link('a'), link('a')] } })).includes('/context/links/1/ref'));
    assert.ok(fieldsOf(binary({ context: { links: [link('context')] } })).includes('/context/links/0/ref'));
    const single = { ...binary(), answerType: 'single', options: [{ value: 'x', label: 'X' }, { value: 'x', label: 'Y' }] };
    assert.ok(fieldsOf(single).includes('/options/1/value'));
  });

  it('attachments carry exactly one of url or inline', () => {
    const att = { ref: 'f', name: 'f.pdf', mediaType: 'application/pdf', size: 1, sha256: 'lkH6Og8R5z-4ABWu2k4_KVQi3cHpBzbaq4jqJsDBhLk' };
    assert.ok(parseHitlRequest(binary({ context: { attachments: [{ ...att, url: 'https://example.com/f.pdf' }] } })).ok);
    assert.ok(parseHitlRequest(binary({ context: { attachments: [{ ...att, inline: 'aGk=' }] } })).ok);
    assert.equal(parseHitlRequest(binary({ context: { attachments: [att] } })).ok, false);
    assert.equal(parseHitlRequest(binary({ context: { attachments: [{ ...att, inline: 'aGk=', url: 'https://example.com/f' }] } })).ok, false);
  });

  it('text patterns must be I-Regexp of at most 256 characters', () => {
    const text = (pattern: string) => ({ spec: 'hitl/request/v0', question: 'Name?', answerType: 'text', bounds: { pattern }, requester: { agentId: 'a' } });
    assert.ok(parseHitlRequest(text('[A-Z][a-z]+')).ok);
    assert.ok(fieldsOf(text('(?=a)b')).includes('/bounds/pattern'));
    assert.ok(fieldsOf(text('\\d+')).includes('/bounds/pattern'));
    assert.ok(fieldsOf(text('a'.repeat(257))).includes('/bounds/pattern'));
  });

  it('ingest refuses an agent-sent id and a mismatched requester', () => {
    const withId = parseHitlRequestForIngest(binary({ id: 'req_1' }), { agentId: 'agent-1' });
    assert.ok(!withId.ok && withId.errors.some((e) => e.field === '/id' && e.hint));
    const other = parseHitlRequestForIngest(binary(), { agentId: 'agent-2' });
    assert.ok(!other.ok && other.errors.some((e) => e.field === '/requester/agentId'));
    assert.ok(parseHitlRequestForIngest(binary(), { agentId: 'agent-1' }).ok);
  });
});

describe('hitl answer validation (host side, never alters the value)', () => {
  const req = (input: unknown) => {
    const r = parseHitlRequest(input);
    assert.ok(r.ok, JSON.stringify(!r.ok && r.errors));
    return r.value as HitlRequest;
  };
  const multi = req(read('examples/requests/03-multi-deploy.json'));
  const number = req(read('examples/requests/04-number-spend-cap.json'));
  const text = req(read('examples/requests/05-text-dog-name.json'));
  const contract = req(read('examples/requests/07-binary-contract-context.json'));

  it('binary: reject needs a reason; mustOpen items must be opened first', () => {
    const opened = new Set(['lnk_terms', 'att_contract']);
    assert.deepEqual(validateHitlAnswer(contract, { status: 'answered', value: 'approve' }, { openedRefs: opened }), []);
    assert.deepEqual(
      validateHitlAnswer(contract, { status: 'answered', value: 'reject' }, { openedRefs: opened }).map((e) => e.field),
      ['/reason'],
    );
    assert.deepEqual(
      validateHitlAnswer(contract, { status: 'answered', value: 'approve' }).map((e) => e.field),
      ['/context/links/0', '/context/attachments/0'],
    );
    assert.deepEqual(validateHitlAnswer(contract, { status: 'declined', reason: 'Not mine to decide' }), []);
    assert.deepEqual(validateHitlAnswer(contract, { status: 'declined', value: 'approve' }).map((e) => e.field), ['/value']);
  });

  it('multi, number and text bounds', () => {
    assert.deepEqual(validateHitlAnswer(multi, { status: 'answered', value: ['staging', 'eu-prod'] }), []);
    assert.ok(validateHitlAnswer(multi, { status: 'answered', value: [] }).length);
    assert.ok(validateHitlAnswer(multi, { status: 'answered', value: ['staging', 'staging'] }).length);
    assert.ok(validateHitlAnswer(multi, { status: 'answered', value: ['mars'] }).length);
    assert.deepEqual(validateHitlAnswer(number, { status: 'answered', value: 150 }), []);
    assert.ok(validateHitlAnswer(number, { status: 'answered', value: 155 }).length);
    assert.ok(validateHitlAnswer(number, { status: 'answered', value: '150' }).length, 'no coercion');
    assert.deepEqual(validateHitlAnswer(text, { status: 'answered', value: ' Rex ' }), []);
    assert.ok(validateHitlAnswer(text, { status: 'answered', value: '' }).length);
  });

  it('multi reasonRequired triggers if any selected value is listed; number/text on exact match', () => {
    const m = req({ ...read('examples/requests/03-multi-deploy.json'), reasonRequired: ['us-prod'] });
    assert.equal(hitlReasonRequiredFor(m, ['staging']), false);
    assert.equal(hitlReasonRequiredFor(m, ['staging', 'us-prod']), true);
    const n = req({ ...read('examples/requests/04-number-spend-cap.json'), reasonRequired: [500] });
    assert.equal(hitlReasonRequiredFor(n, 500), true);
    assert.equal(hitlReasonRequiredFor(n, 490), false);
  });
});
