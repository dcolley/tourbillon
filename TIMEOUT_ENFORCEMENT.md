# Agent Timeout Enforcement

## Implementation

The agent timeout field (`runtimeConfig.timeout.heartbeatSec`) is now a **real wall-clock abort** that terminates hung wakes.

### Mechanism

**Wall-clock timer** (wake-runner.ts:445-453):
```typescript
const timeoutSec = runtimeConfig.timeout?.heartbeatSec ?? 300;
wallClockTimer = setTimeout(() => {
  abortController.abort(new Error(`Heartbeat exceeded wall-clock timeout of ${timeoutSec}s`));
}, timeoutSec * 1000);
```

**Abort promise races with stream** (wake-runner.ts:765-775):
```typescript
const abortPromise = new Promise<never>((_, reject) => {
  if (abortSignal.aborted) {
    reject(heartbeatAbortedError());
    return;
  }
  const abortHandler = () => {
    streamResult?.cleanup();
    reject(heartbeatAbortedError());
  };
  abortSignal.addEventListener('abort', abortHandler, { once: true });
});
```

**Stream races with abort and tripwire** (wake-runner.ts:810-819):
```typescript
await Promise.race([
  (async () => {
    const streamed = await durableAgent.stream(...);
    streamResult = streamed;
    await Promise.race([
      streamed.output.text,
      tripwirePromise,
      abortPromise,  // ← Abort stops waiting for stream
    ]);
  })(),
  tripwirePromise,
  abortPromise,  // ← Abort stops waiting for stream()
]);
```

### Behavior

1. **Wall-clock timer** at `runWake()` level aborts after `timeoutSec`
2. **Abort promise** races with both the initial `stream()` call and `output.text`
3. **Stream cleanup** called when abort fires
4. **Error message** extracted from abort reason: `"Heartbeat exceeded wall-clock timeout of Ns"`
5. **last-seen pings** stop (pingHeartbeat already no-ops when aborted)

### Coverage

- ✅ **Harness path**: driveSessionHeadless already had wall-clock timer
- ✅ **Durable/mastra path**: now races abort with stream
- ✅ **Timer wakes**: covered by runWake timer
- ✅ **On-demand wakes**: covered by runWake timer
- ✅ **Force-kill**: uses same abortController.abort() mechanism

### Default

- Unset / never-saved → **300 seconds**
- No silent 1200s cap

### Error Handling

**heartbeat-abort.ts** extracts timeout from abort reason:
```typescript
// Check for wall-clock timeout in abort reason
if (abortReason instanceof Error && abortReason.message.includes('wall-clock timeout')) {
  return abortReason.message;
}

// Check for wall-clock timeout in error itself
if (err instanceof Error && err.message.includes('wall-clock timeout')) {
  return err.message;
}
```

### Critical Properties

1. **Abort stops stream**: Promise.race ensures we don't wait for hung stream
2. **Duration matches timeout**: Wall-clock timer fires after exactly `timeoutSec`
3. **Error quotes configured value**: Error interpolates `timeoutSec`, not hardcoded 1200
4. **Cleanup happens**: `streamResult?.cleanup()` called on abort
5. **Force-kill same path**: Operator kill uses same `abortController.abort()`

## Testing Strategy

**Manual testing required** (integration tests with real LLM hang are complex):

1. Set agent timeout to 60s
2. Trigger wake that hangs (model returns no output)
3. Verify:
   - Run fails at ~60-65s (±5s overhead)
   - Error: `"Heartbeat exceeded wall-clock timeout of 60s"`
   - `finishedAt - startedAt` ≈ 60s
   - `lastSeenAt` stopped updating around 60s
   - Error does NOT say 300s or 1200s

4. Test unset timeout:
   - Leave timeout field empty
   - Verify default 300s is used

5. Test force-kill:
   - Set long timeout (300s)
   - Click force-kill during hung wake
   - Verify immediate failure with "Force-killed by operator"

## Files Changed

- `packages/scheduler/src/wake-runner.ts` — wall-clock timer + abort promise
- `packages/scheduler/src/heartbeat-abort.ts` — extract timeout from abort reason

## Out of Scope

- Observational memory, heartbeat intervals, timer schedules
- Changing TEST or backfilling agent configs
- MCP or HMR work
