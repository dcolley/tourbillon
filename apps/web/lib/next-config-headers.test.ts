/** CHAT-1 hardening: every response carries X-Content-Type-Options: nosniff (next.config headers). */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

describe('CHAT-1 hardening next.config headers', () => {
  it('sets nosniff on all paths', async () => {
    const url = pathToFileURL(path.join(__dirname, '..', 'next.config.mjs')).href;
    const config = (await import(url)).default as { headers?: () => Promise<{ source: string; headers: { key: string; value: string }[] }[]> };
    assert.equal(typeof config.headers, 'function');
    const rules = await config.headers!();
    const all = rules.find((r) => r.source === '/:path*');
    assert.ok(all, 'a rule for every path');
    assert.deepEqual(all!.headers.find((h) => h.key === 'X-Content-Type-Options'), {
      key: 'X-Content-Type-Options',
      value: 'nosniff',
    });
  });
});
