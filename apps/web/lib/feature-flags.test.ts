import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { isControlChatEnabled } from './feature-flags';

const KEY = 'NEXT_PUBLIC_CONTROL_CHAT_ENABLED';
const original = process.env[KEY];

describe('UI-0 isControlChatEnabled', () => {
  afterEach(() => {
    if (original === undefined) delete process.env[KEY];
    else process.env[KEY] = original;
  });

  it('is off when the env var is unset', () => {
    delete process.env[KEY];
    assert.equal(isControlChatEnabled(), false);
  });

  it("is off when the env var is 'false'", () => {
    process.env[KEY] = 'false';
    assert.equal(isControlChatEnabled(), false);
  });

  it("is on only for the exact value 'true'", () => {
    process.env[KEY] = 'true';
    assert.equal(isControlChatEnabled(), true);
  });

  it('is off for any other value', () => {
    for (const v of ['', 'TRUE', 'True', ' true', 'true ', '1', 'yes', 'on']) {
      process.env[KEY] = v;
      assert.equal(isControlChatEnabled(), false, `value ${JSON.stringify(v)}`);
    }
  });
});
