import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  isAssistantAvailable,
  isControlChatEnabled,
  isControlChatServerEnabled,
  legacyControlChatStartupWarnings,
  logLegacyControlChatStartupWarnings,
} from './feature-flags';

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

const LEGACY_KEYS = ['CONTROL_CHAT_ENABLED', 'NEXT_PUBLIC_CONTROL_CHAT_ENABLED', 'ASSISTANT_ENABLED'] as const;
type LegacyEnv = Partial<Record<(typeof LEGACY_KEYS)[number], string>>;
const savedLegacy = Object.fromEntries(LEGACY_KEYS.map((k) => [k, process.env[k]]));
function setLegacy(values: LegacyEnv) {
  for (const k of LEGACY_KEYS) {
    if (values[k] === undefined) delete process.env[k];
    else process.env[k] = values[k];
  }
}
function restoreLegacy() {
  for (const k of LEGACY_KEYS) {
    if (savedLegacy[k] === undefined) delete process.env[k];
    else process.env[k] = savedLegacy[k];
  }
}

describe('isAssistantAvailable', () => {
  afterEach(restoreLegacy);

  it("is on unless ASSISTANT_ENABLED is exactly 'false'", () => {
    for (const [value, expected] of [
      [undefined, true],
      ['true', true],
      ['', true],
      ['FALSE', true],
      ['0', true],
      ['false', false],
    ] as Array<[string | undefined, boolean]>) {
      setLegacy({ ASSISTANT_ENABLED: value });
      assert.equal(isAssistantAvailable(), expected, `value ${JSON.stringify(value)}`);
    }
  });
});

describe('isControlChatServerEnabled (legacy chat session API)', () => {
  afterEach(restoreLegacy);

  it("is on only when both legacy flags are exactly 'true' and the assistant is off", () => {
    const cases: Array<[LegacyEnv, boolean]> = [
      [{}, false],
      [{ CONTROL_CHAT_ENABLED: 'true' }, false],
      [{ NEXT_PUBLIC_CONTROL_CHAT_ENABLED: 'true' }, false],
      [{ CONTROL_CHAT_ENABLED: 'true', NEXT_PUBLIC_CONTROL_CHAT_ENABLED: 'true' }, false],
      [{ CONTROL_CHAT_ENABLED: 'true', NEXT_PUBLIC_CONTROL_CHAT_ENABLED: 'true', ASSISTANT_ENABLED: 'true' }, false],
      [{ CONTROL_CHAT_ENABLED: 'true', NEXT_PUBLIC_CONTROL_CHAT_ENABLED: 'true', ASSISTANT_ENABLED: 'FALSE' }, false],
      [{ CONTROL_CHAT_ENABLED: 'true', NEXT_PUBLIC_CONTROL_CHAT_ENABLED: 'false', ASSISTANT_ENABLED: 'false' }, false],
      [{ CONTROL_CHAT_ENABLED: '1', NEXT_PUBLIC_CONTROL_CHAT_ENABLED: 'true', ASSISTANT_ENABLED: 'false' }, false],
      [{ CONTROL_CHAT_ENABLED: 'TRUE', NEXT_PUBLIC_CONTROL_CHAT_ENABLED: 'true', ASSISTANT_ENABLED: 'false' }, false],
      [{ CONTROL_CHAT_ENABLED: 'true', NEXT_PUBLIC_CONTROL_CHAT_ENABLED: 'true', ASSISTANT_ENABLED: 'false' }, true],
    ];
    for (const [values, expected] of cases) {
      setLegacy(values);
      assert.equal(isControlChatServerEnabled(), expected, JSON.stringify(values));
    }
  });
});

describe('legacy Control Pane chat startup warnings', () => {
  const g = globalThis as { tourbillonControlChatStartupLogged?: boolean };
  afterEach(() => {
    restoreLegacy();
    delete g.tourbillonControlChatStartupLogged;
  });

  it('nothing when no legacy flag is set', () => {
    for (const assistant of [undefined, 'true', 'false']) {
      setLegacy({ ASSISTANT_ENABLED: assistant });
      assert.deepEqual(legacyControlChatStartupWarnings(), [], `assistant ${assistant}`);
    }
  });

  it('legacy flags set while the assistant is available: one warning saying they are ignored', () => {
    for (const values of [
      { CONTROL_CHAT_ENABLED: 'true' },
      { NEXT_PUBLIC_CONTROL_CHAT_ENABLED: 'true' },
      { CONTROL_CHAT_ENABLED: 'true', NEXT_PUBLIC_CONTROL_CHAT_ENABLED: 'true' },
      { CONTROL_CHAT_ENABLED: 'true', NEXT_PUBLIC_CONTROL_CHAT_ENABLED: 'true', ASSISTANT_ENABLED: 'true' },
    ] as LegacyEnv[]) {
      setLegacy(values);
      const warnings = legacyControlChatStartupWarnings();
      assert.equal(warnings.length, 1, JSON.stringify(values));
      assert.match(warnings[0], /ignored while the assistant is available/);
      assert.match(warnings[0], /\(404\)/);
    }
  });

  it('assistant off, only one legacy flag: says both are needed and the API stays off', () => {
    for (const values of [
      { CONTROL_CHAT_ENABLED: 'true', ASSISTANT_ENABLED: 'false' },
      { NEXT_PUBLIC_CONTROL_CHAT_ENABLED: 'true', ASSISTANT_ENABLED: 'false' },
    ] as LegacyEnv[]) {
      setLegacy(values);
      const warnings = legacyControlChatStartupWarnings();
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /needs both CONTROL_CHAT_ENABLED and\s+NEXT_PUBLIC_CONTROL_CHAT_ENABLED/);
    }
  });

  it('assistant off and both legacy flags on: says the legacy API is on', () => {
    setLegacy({ CONTROL_CHAT_ENABLED: 'true', NEXT_PUBLIC_CONTROL_CHAT_ENABLED: 'true', ASSISTANT_ENABLED: 'false' });
    const warnings = legacyControlChatStartupWarnings();
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /legacy chat session API is on/);
  });

  it('warnings name the variables only, never their values', () => {
    const marker = 'true-but-unusual-value-xyz';
    setLegacy({ CONTROL_CHAT_ENABLED: marker, NEXT_PUBLIC_CONTROL_CHAT_ENABLED: 'true' });
    for (const w of legacyControlChatStartupWarnings()) assert.ok(!w.includes(marker));
  });

  it('logs once per process', () => {
    setLegacy({ CONTROL_CHAT_ENABLED: 'true', NEXT_PUBLIC_CONTROL_CHAT_ENABLED: 'true' });
    const logged: string[] = [];
    logLegacyControlChatStartupWarnings((m) => logged.push(m));
    logLegacyControlChatStartupWarnings((m) => logged.push(m));
    assert.equal(logged.length, 1);
    assert.match(logged[0], /^\[control-chat\] /);
  });
});
