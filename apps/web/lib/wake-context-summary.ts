/**
 * WC6 AC4: one read-only line for the heartbeat run page from contextSnapshot.wakeContext.
 * Returns null for runs recorded before wake compression (no wakeContext in the snapshot).
 */
export function wakeContextSummary(contextSnapshot: unknown): string | null {
  if (!contextSnapshot || typeof contextSnapshot !== 'object') return null;
  const wc = (contextSnapshot as Record<string, unknown>).wakeContext;
  if (!wc || typeof wc !== 'object') return null;
  const w = wc as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const annotations = n(w.annotated);
  let line =
    `Wake context: header ${n(w.headerChars)} chars, comments ${n(w.commentChars)} chars, ` +
    `${annotations} annotation${annotations === 1 ? '' : 's'}`;
  if (w.mode === 'minimal') return 'Wake context: minimal message (the wake details could not be rendered)';
  if (w.mode === 't1') {
    line +=
      w.fallback === 'v2_render_failed'
        ? ' (compressed view failed to render; newest comments only)'
        : typeof w.error === 'string'
          ? ' (live state unavailable; newest comments only)'
          : ' (newest comments only)';
  }
  return line;
}
