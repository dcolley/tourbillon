/**
 * CHAT-SEND-KEY wiring pins. There is no DOM library for `agent-chat-pane.tsx` (the Control-Pane
 * chat), so the routing of its composer through the ONE shared helper is pinned at source level —
 * the same idiom as agent-code-execution-form.test.ts. The behaviour itself is covered by
 * lib/chat-send-key.test.ts, the composer controller/view tests and agent-chat-send-key.test.ts.
 *
 * These pins fail if a composer grows its own Enter logic again, if the preference stops being a
 * single localStorage key, or if a chat surface loses its "Send message with" control.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const read = (rel: string) => readFileSync(path.join(__dirname, rel), 'utf-8');

const PREF = read('./chat-send-key.ts');
const CONTROLLER = read('../components/assistant/composer/composer-controller.ts');
const COMPOSER_VIEW = read('../components/assistant/composer/composer.tsx');
const ASSISTANT = read('../components/assistant/agent-chat.tsx');
const ASSISTANT_MENU = read('../components/assistant/agent-chat-menu.tsx');
const PANE = read('../components/chat/agent-chat-pane.tsx');
const MENU = read('../components/chat/chat-send-key-menu.tsx');
const HOOK = read('../components/chat/use-chat-send-key-mode.ts');

describe('CHAT-SEND-KEY one preference store', () => {
  it('is one localStorage key with the enter_sends default (no DB, no migration)', () => {
    assert.match(PREF, /export const CHAT_SEND_KEY_STORAGE_KEY = 'tourbillon\.chat\.sendKey';/);
    assert.match(PREF, /export const DEFAULT_CHAT_SEND_KEY_MODE: ChatSendKeyMode = 'enter_sends';/);
    assert.match(PREF, /export const CHAT_SEND_KEY_SETTINGS_LABEL = 'Send message with';/);
    assert.doesNotMatch(PREF, /@tourbillon\/db/);
    assert.doesNotMatch(PREF, /fetch\(/);
    assert.equal((PREF.match(/localStorage\.(getItem|setItem)/g) ?? []).length, 2, 'one read and one write site');
  });

  it('the gesture helper is the only Enter decision, and every surface imports it', () => {
    for (const [name, src] of [['controller', CONTROLLER], ['assistant', ASSISTANT], ['pane', PANE]] as const) {
      assert.match(src, /resolveSendKeyGesture\(/, `${name} routes its composer through the shared helper`);
      assert.doesNotMatch(src, /key !== 'Enter'|key === 'Enter'|key === "Enter"/, `${name} has no private Enter logic`);
    }
    for (const [name, src] of [['composer view', COMPOSER_VIEW], ['assistant', ASSISTANT], ['pane', PANE]] as const) {
      assert.match(src, /chatSendKeyHint\(/, `${name} shows the mode-aware hint`);
    }
  });
});

describe('CHAT-SEND-KEY composer wiring', () => {
  it('the composer controller delegates its keydown and exposes the live mode', () => {
    assert.match(
      CONTROLLER,
      /const gesture = resolveSendKeyGesture\(e, \{ mode: state\.sendKeyMode, runOpen: runOpen\(\) \}\);/,
    );
    assert.match(CONTROLLER, /if \(gesture === 'steer'\) void controller\.steer\(\);/, 'steer gesture routes to steer()');
    assert.match(CONTROLLER, /else void controller\.primary\(\);/, 'send gesture routes to primary()');
    assert.match(CONTROLLER, /setSendKeyMode\(mode: unknown\) \{/, 'the mode is settable at runtime (no reload)');
  });

  it('the composer view pushes the stored pref into its controller and renders the hint from state', () => {
    assert.match(COMPOSER_VIEW, /useChatSendKeyMode\(\)/, 'the composer reads the stored pref');
    assert.match(COMPOSER_VIEW, /controller\.setSendKeyMode\(mode\);/, 'a pref flip re-binds the live controller');
    assert.match(COMPOSER_VIEW, /chatSendKeyHint\(state\.sendKeyMode, \{ running: true \}\)/, 'running hint');
    assert.match(COMPOSER_VIEW, /chatSendKeyHint\(state\.sendKeyMode\)/, 'idle hint');
    assert.match(COMPOSER_VIEW, /data-send-key-mode=\{state\.sendKeyMode\}/, 'the active mode is observable in the DOM');
  });

  it('the assistant composer routes send and steer to the container callbacks', () => {
    assert.match(ASSISTANT, /const gesture = resolveSendKeyGesture\(e, \{ mode: sendKeyMode, runOpen \}\);/);
    assert.match(ASSISTANT, /if \(gesture === 'steer'\) props\.onSteer\(\);/, 'steer goes to onSteer');
    assert.match(ASSISTANT, /else props\.onSend\(\);/, 'send goes to onSend');
    // S301-S1/S302-S1: the call may ride the module's __test__ seam (the seam holds the real hook
    // by default; a swapped stub would change behaviour, which is what the render tests exploit).
    assert.match(ASSISTANT, /const \[sendKeyMode\] = (__test__\.)?useChatSendKeyMode\(\);/, 'the container holds the pref');
    assert.match(ASSISTANT, /sendKeyMode=\{sendKeyMode\}/, 'the view receives it');
  });

  it('the Control-Pane chat pane routes send and steer too', () => {
    assert.match(
      PANE,
      /const gesture = resolveSendKeyGesture\(e, \{\s*mode: chatSendKeyMode,\s*runOpen: running,\s*\}\);/,
    );
    assert.match(PANE, /if \(gesture === 'steer'\) void steer\(input\);/, 'steer keeps the steer path');
    assert.match(PANE, /else void sendMessage\(input\);/, 'send keeps the send path');
    assert.match(PANE, /const \[chatSendKeyMode\] = (__test__\.)?useChatSendKeyMode\(\);/, 'the pane reads the stored pref (possibly via the seam)');
    assert.match(PANE, /data-send-key-mode=\{chatSendKeyMode\}/, 'the pane shows the active mode');
  });
});

describe('CHAT-SEND-KEY settings control', () => {
  it('the control is labelled "Send message with" and writes the shared pref', () => {
    assert.match(MENU, /CHAT_SEND_KEY_SETTINGS_LABEL/);
    assert.match(MENU, /DropdownMenuRadioItem value="enter_sends"/);
    assert.match(MENU, /DropdownMenuRadioItem\s+value="mod_enter_sends"/);
    assert.match(MENU, /isChatSendKeyMode\(value\)/, 'only the two modes can be written');
    assert.match(HOOK, /writeChatSendKeyMode\(next\)/, 'the control writes through to the store');
    assert.match(HOOK, /subscribeChatSendKeyMode\(onStoreChange\)/, 'and follows changes from anywhere (hot reload)');
    assert.match(HOOK, /useSyncExternalStore\(subscribe, getSnapshot, getServerSnapshot\)/, 'read as an external store, no setState-in-effect');
  });

  it('both chat surfaces mount it', () => {
    assert.match(PANE, /<(__test__\.)?ChatSendKeyMenu \/>/, 'the Control-Pane chat header has the control (possibly via the seam)');
    assert.match(ASSISTANT_MENU, /<ChatSendKeyRadioGroup mode=\{sendKeyMode\} onModeChange=\{setSendKeyMode\} \/>/, 'the assistant ⋯ menu has it');
  });
});
