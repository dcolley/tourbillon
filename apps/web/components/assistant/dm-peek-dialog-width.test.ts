/**
 * DM-MODAL-WID S1: pins the DM conversation modal's DialogContent width contract.
 *
 * The modal renders through a Radix portal, so the DOM the SSR tests see never contains the
 * DialogContent classes — width mutants (wrong 42rem cap, dropped `sm:` prefix, `max-w-2xl`
 * base with no phone gutter) all passed the unit suite while the gate caught them only via a
 * headless-Chrome layout probe. The class string is now exported from dm-peek-dialog.tsx and
 * asserted here: no portal, no browser, kills the three mutants by string pin.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

type Peek = typeof import('./dm-peek-dialog');
let DM_DIALOG_CONTENT_CLASS: Peek['DM_DIALOG_CONTENT_CLASS'];

describe('DM-MODAL-WID DM dialog width contract', () => {
  before(async () => {
    ({ DM_DIALOG_CONTENT_CLASS } = await import('./dm-peek-dialog'));
  });

  it('pins the exact width contract: phone gutter + sm-prefixed 90vw/72rem cap', () => {
    // Exact match is the strongest pin: it kills every mutant at once and forces a conscious
    // edit here whenever the layout contract legitimately changes.
    assert.equal(
      DM_DIALOG_CONTENT_CLASS,
      'flex max-h-[85vh] max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(90vw,72rem)]',
    );
  });

  it('keeps the phone gutter (mutant: keep max-w-2xl base → full-bleed on phones)', () => {
    // The shared DialogContent base is `max-w-[calc(100%-2rem)] sm:max-w-sm`; the modal must
    // carry the gutter class itself and must NOT fall back to max-w-2xl full-bleed.
    assert.match(DM_DIALOG_CONTENT_CLASS, /(?:^|\s)max-w-\[calc\(100%-2rem\)\](?:\s|$)/);
    assert.ok(!DM_DIALOG_CONTENT_CLASS.includes('max-w-2xl'), 'no max-w-2xl: it overrides the phone gutter');
  });

  it('keeps the desktop cap at 90vw/72rem under the sm: prefix (mutants: 42rem cap; dropped sm:)', () => {
    // Wrong cap (42rem) freezes the dialog at 672px on desktop.
    assert.match(DM_DIALOG_CONTENT_CLASS, /(?:^|\s)sm:max-w-\[min\(90vw,72rem\)\](?:\s|$)/);
    assert.ok(!DM_DIALOG_CONTENT_CLASS.includes('42rem'), 'cap must be 72rem, not 42rem');
    // Without `sm:` the cap is unconditional and tailwind-merge drops the gutter/base pair,
    // leaving the shared base `sm:max-w-sm` to win on desktop (384px dialog).
    assert.ok(
      !/(?:^|\s)max-w-\[min\(90vw,72rem\)\](?:\s|$)/.test(DM_DIALOG_CONTENT_CLASS),
      'the 90vw/72rem cap must be sm:-prefixed, never bare',
    );
    // A space inside the arbitrary value breaks the Tailwind class entirely.
    assert.ok(!DM_DIALOG_CONTENT_CLASS.includes('min(90vw, 72rem)'), 'no space in the arbitrary min() value');
  });
});
