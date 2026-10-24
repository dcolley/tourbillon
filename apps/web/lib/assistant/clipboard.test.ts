/** CHAT-2: copy helper used by code blocks and tables. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { copyText } from './clipboard';

describe('CHAT-2 copyText', () => {
  it('writes exactly the given text', async () => {
    const written: string[] = [];
    assert.equal(await copyText('const a = 1;\n', { writeText: async (t) => void written.push(t) }), true);
    assert.deepEqual(written, ['const a = 1;\n']);
  });

  it('resolves false with no clipboard or a refused write', async () => {
    assert.equal(await copyText('x', null), false);
    assert.equal(await copyText('x', { writeText: async () => Promise.reject(new Error('denied')) }), false);
  });
});
