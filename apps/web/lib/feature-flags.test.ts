import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { isControlChatEnabled, isControlChatServerEnabled } from './feature-flags';

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

describe('isControlChatServerEnabled (legacy chat session API)', () => {
  const SERVER = 'CONTROL_CHAT_ENABLED';
  const originalServer = process.env[SERVER];
  afterEach(() => {
    if (original === undefined) delete process.env[KEY];
    else process.env[KEY] = original;
    if (originalServer === undefined) delete process.env[SERVER];
    else process.env[SERVER] = originalServer;
  });

  it("is on only when both flags are exactly 'true'", () => {
    const cases: Array<[string | undefined, string | undefined, boolean]> = [
      [undefined, undefined, false],
      ['true', undefined, false],
      [undefined, 'true', false],
      ['true', 'false', false],
      ['1', 'true', false],
      ['TRUE', 'true', false],
      ['true', 'true', true],
    ];
    for (const [server, build, expected] of cases) {
      if (server === undefined) delete process.env[SERVER];
      else process.env[SERVER] = server;
      if (build === undefined) delete process.env[KEY];
      else process.env[KEY] = build;
      assert.equal(isControlChatServerEnabled(), expected, `server=${server} build=${build}`);
    }
  });
});
