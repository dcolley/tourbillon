import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { UNIX_SOCKET_PATH_MAX, egressProxySocketPath } from './egress-enforcement';
import { egressTestSocketSalt, testEgressProxySocketPath } from './egress-socket-test-key';

// S268-S4 (Refs #268): egressProxySocketPath(companyId, 'dns') is host-global,
// so parallel gate worktrees on one host started on the same
// /tmp/tourbillon-egress/<hash>.sock and deleted each other's socket
// (`bwrap: Can't find source path …sock`). Test sockets are now salted with
// the repo/worktree root and the pid before hashing.

describe('testEgressProxySocketPath worktree/process keying (S268-S4)', () => {
  it('two worktrees get different paths for the same fixed companyId', () => {
    const pathA = testEgressProxySocketPath('co-bwrap', 'dns', [], {
      repoRoot: '/home/derek/tourbillon-soft-268-s1-s4/packages/mastra',
      pid: 4242,
    });
    const pathB = testEgressProxySocketPath('co-bwrap', 'dns', [], {
      repoRoot: '/home/derek/tourbillon-soft-267-s2-s6/packages/mastra',
      pid: 4242,
    });
    assert.notEqual(pathA, pathB, 'same companyId+task in two worktrees must not share a socket');
  });

  it('two processes in one worktree get different paths (CI shards)', () => {
    const sameRoot = '/home/derek/tourbillon-soft-268-s1-s4/packages/mastra';
    assert.notEqual(
      testEgressProxySocketPath('co-bwrap', 'dns', [], { repoRoot: sameRoot, pid: 111 }),
      testEgressProxySocketPath('co-bwrap', 'dns', [], { repoRoot: sameRoot, pid: 222 }),
      'pid must also break ties',
    );
  });

  it('is deterministic within a process so teardown unlinks its own socket', () => {
    const opts = { repoRoot: '/w/one', pid: 99 };
    assert.equal(
      testEgressProxySocketPath('co-bwrap', 'dns', ['example.com'], opts),
      testEgressProxySocketPath('co-bwrap', 'dns', ['example.com'], opts),
    );
    // Different task or allow-list still differ.
    assert.notEqual(
      testEgressProxySocketPath('co-bwrap', 'dns', ['example.com'], opts),
      testEgressProxySocketPath('co-bwrap', 'other', ['example.com'], opts),
    );
  });

  it('stays a <hash>.sock under the socket root, inside the AF_UNIX length limit', () => {
    // Long repo root: salt is hashed, so the materialized path never grows.
    const path = testEgressProxySocketPath('co-bwrap', 'dns', [], {
      repoRoot: `/very/long/worktree/path/${'x'.repeat(120)}`,
      pid: process.pid,
    });
    const base = path.split('/').pop() ?? '';
    assert.match(base, /^[0-9a-f]{16}\.sock$/, `hashed file name must not leak the salt: ${base}`);
    assert.ok(Buffer.byteLength(path, 'utf8') <= UNIX_SOCKET_PATH_MAX, `${path} exceeds ${UNIX_SOCKET_PATH_MAX} bytes`);
    // Same length shape as the un-salted path (fixed-width hash file name).
    const plain = egressProxySocketPath('co-bwrap', 'dns');
    assert.equal(
      base.length,
      plain.split('/').pop()!.length,
      'salted file name is the same fixed hash width',
    );
    assert.ok(Buffer.byteLength(plain, 'utf8') <= UNIX_SOCKET_PATH_MAX);
  });

  it('salt changes with root or pid only, and is short', () => {
    const a = egressTestSocketSalt('/w/one', 1);
    assert.equal(a, egressTestSocketSalt('/w/one', 1));
    assert.notEqual(a, egressTestSocketSalt('/w/two', 1));
    assert.notEqual(a, egressTestSocketSalt('/w/one', 2));
    assert.match(a, /^wt[0-9a-f]{8}p\d+$/);
  });
});
