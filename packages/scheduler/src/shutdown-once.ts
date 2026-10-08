/**
 * Wrap the scheduler's async shutdown so it runs once: a second or third SIGTERM/SIGINT reuses
 * the first call's promise (one dropped-deferred-wakes warning line, one close), never a rerun.
 */
export function onceAsync(fn: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | undefined;
  return () => {
    running ??= fn();
    return running;
  };
}

type SignalTarget = { on(signal: 'SIGTERM' | 'SIGINT', listener: () => void): unknown };

/** Run `shutdown` on SIGTERM / SIGINT, once however many signals arrive. Returns the guarded fn. */
export function onShutdownSignals(target: SignalTarget, shutdown: () => Promise<void>): () => Promise<void> {
  const guarded = onceAsync(shutdown);
  target.on('SIGTERM', () => {
    void guarded();
  });
  target.on('SIGINT', () => {
    void guarded();
  });
  return guarded;
}
