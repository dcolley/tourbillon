'use client';

/**
 * TB-HOTFIX-REDACT (SHOULD-2): the ONE technical-details toggle control, using the exact
 * #364/#370 FailureBlock selectors so the failed NOTICE and (after merge) the failed USER
 * MESSAGE share one control:
 *
 *  - control: [data-error-details-toggle] with aria-expanded ("false" closed / "true"
 *    open) and aria-controls pointing at the body id;
 *  - body: [data-error-details], ABSENT from the DOM when closed; the redacted technical
 *    text rendered as React text (escaped — never dangerouslySetInnerHTML);
 *  - NEVER a native <details> (M6): the open state is React state, seeded from the
 *    `initiallyOpen` prop (the detailsOpen test seam flows through it).
 */
import * as React from 'react';

export function ErrorDetailsToggle({
  technical,
  initiallyOpen = false,
  label = 'Error details',
}: {
  technical: string;
  initiallyOpen?: boolean;
  label?: string;
}) {
  const [open, setOpen] = React.useState(initiallyOpen);
  // Stable per-position id (stable across renderToStaticMarkup passes → reload-stable SSR).
  const bodyId = React.useId();
  return (
    <>
      <button
        type="button"
        data-error-details-toggle
        aria-expanded={open ? 'true' : 'false'}
        aria-controls={bodyId}
        className="mt-1 text-xs underline decoration-dotted underline-offset-2"
        onClick={() => setOpen((o) => !o)}
      >
        {label}
      </button>
      {open ? (
        <div
          data-error-details
          id={bodyId}
          className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border border-border/60 bg-background/60 p-2 font-mono text-xs"
        >
          {technical}
        </div>
      ) : null}
    </>
  );
}
