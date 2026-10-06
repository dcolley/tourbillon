import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  EGRESS_ALLOW_LIST_HELP,
  EGRESS_ALLOW_LIST_ISOLATION_WARNING,
  egressAllowListNeedsBwrap,
  inferEgressAllowListMode,
  parseEgressAllowListEntry,
  parseEgressAllowListMode,
  resolveEgressAllowListInput,
  sanitizeEgressAllowList,
} from './egress-allow-list';

describe('parseEgressAllowListEntry', () => {
  it('accepts exact hosts', () => {
    assert.deepEqual(parseEgressAllowListEntry('api.example.com'), {
      ok: true,
      entry: 'api.example.com',
      kind: 'host',
    });
    assert.deepEqual(parseEgressAllowListEntry('LocalHost'), {
      ok: true,
      entry: 'localhost',
      kind: 'host',
    });
  });

  it('accepts *.domain wildcards', () => {
    assert.deepEqual(parseEgressAllowListEntry('*.example.com'), {
      ok: true,
      entry: '*.example.com',
      kind: 'wildcard',
    });
  });

  it('accepts IPv4 and IPv4 CIDR', () => {
    assert.deepEqual(parseEgressAllowListEntry('10.0.0.1'), {
      ok: true,
      entry: '10.0.0.1',
      kind: 'ipv4',
    });
    assert.deepEqual(parseEgressAllowListEntry('10.0.0.0/8'), {
      ok: true,
      entry: '10.0.0.0/8',
      kind: 'cidr',
    });
    assert.deepEqual(parseEgressAllowListEntry('0.0.0.0/0'), {
      ok: true,
      entry: '0.0.0.0/0',
      kind: 'cidr',
    });
  });

  it('rejects bare *', () => {
    assert.equal(parseEgressAllowListEntry('*').ok, false);
    assert.match((parseEgressAllowListEntry('*') as { error: string }).error, /Bare \*/);
    assert.equal(parseEgressAllowListEntry('foo*bar.com').ok, false);
  });

  it('rejects IPv6', () => {
    assert.match((parseEgressAllowListEntry('::1') as { error: string }).error, /IPv6/);
    assert.match((parseEgressAllowListEntry('2001:db8::1') as { error: string }).error, /IPv6/);
    assert.match((parseEgressAllowListEntry('[::1]') as { error: string }).error, /IPv6/);
  });

  it('rejects URLs, paths, and ports', () => {
    assert.match((parseEgressAllowListEntry('https://example.com') as { error: string }).error, /URL/);
    assert.match((parseEgressAllowListEntry('http://10.0.0.1/path') as { error: string }).error, /URL/);
    assert.match((parseEgressAllowListEntry('example.com/path') as { error: string }).error, /Path/);
    assert.match((parseEgressAllowListEntry('example.com:443') as { error: string }).error, /Port/);
    assert.match((parseEgressAllowListEntry('10.0.0.1:80') as { error: string }).error, /Port/);
  });

  it('rejects invalid CIDR and incomplete IPv4', () => {
    assert.equal(parseEgressAllowListEntry('10.0.0.0/33').ok, false);
    assert.equal(parseEgressAllowListEntry('10.0.0.1/24').ok, true);
    assert.equal(parseEgressAllowListEntry('1.2.3').ok, false);
    assert.equal(parseEgressAllowListEntry('999.1.1.1').ok, false);
  });

  it('rejects empty and malformed wildcards', () => {
    assert.equal(parseEgressAllowListEntry('   ').ok, false);
    assert.equal(parseEgressAllowListEntry('*.').ok, false);
    assert.equal(parseEgressAllowListEntry('*example.com').ok, false);
  });
});

describe('sanitizeEgressAllowList / resolveEgressAllowListInput', () => {
  it('trims, lowercases hosts, and drops duplicates', () => {
    assert.deepEqual(
      sanitizeEgressAllowList([' API.Example.com ', 'api.example.com', '10.0.0.1']),
      ['api.example.com', '10.0.0.1'],
    );
  });

  it('throws on the first invalid entry', () => {
    assert.throws(() => sanitizeEgressAllowList(['example.com', '*']), /Bare \*/);
  });

  it('maps the three modes', () => {
    assert.equal(resolveEgressAllowListInput('off', ['example.com']), null);
    assert.deepEqual(resolveEgressAllowListInput('empty', ['example.com']), []);
    assert.deepEqual(resolveEgressAllowListInput('list', ['*.example.com', '10.0.0.0/8']), [
      '*.example.com',
      '10.0.0.0/8',
    ]);
    assert.deepEqual(resolveEgressAllowListInput('list', []), []);
  });

  it('infers mode from a stored list', () => {
    assert.equal(inferEgressAllowListMode(undefined), 'off');
    assert.equal(inferEgressAllowListMode([]), 'empty');
    assert.equal(inferEgressAllowListMode(['example.com']), 'list');
    assert.equal(parseEgressAllowListMode('list'), 'list');
    assert.equal(parseEgressAllowListMode('nope'), 'off');
  });
});

describe('isolation warning helpers', () => {
  it('flags a non-empty list on none/seatbelt only', () => {
    assert.equal(egressAllowListNeedsBwrap('none', ['api.example.com']), true);
    assert.equal(egressAllowListNeedsBwrap('seatbelt', ['api.example.com']), true);
    assert.equal(egressAllowListNeedsBwrap('bwrap', ['api.example.com']), false);
    assert.equal(egressAllowListNeedsBwrap('none', []), false);
    assert.equal(egressAllowListNeedsBwrap('seatbelt', undefined), false);
  });

  it('publishes the required help and warning copy', () => {
    assert.ok(EGRESS_ALLOW_LIST_HELP.some((line) => line.includes('subdomains only')));
    assert.ok(EGRESS_ALLOW_LIST_HELP.some((line) => line.includes('IP literal')));
    assert.ok(EGRESS_ALLOW_LIST_HELP.some((line) => line.includes('All ports are allowed')));
    assert.match(EGRESS_ALLOW_LIST_ISOLATION_WARNING, /none or seatbelt/);
  });
});
