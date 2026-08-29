# Agent Timeout Test Requirements

## Production Test Gap

Unit tests (`timeout-production.test.ts`) verify error extraction logic (3/3 passing) but **cannot test the production wake path** without:
1. Full test database with companies/agents tables
2. Mock LLM that hangs (`durableAgent.stream()` never returns)
3. Test harness that runs actual `runWake()` with hung agent

**Manual testing on TEST is required** to verify timeout enforcement with real hung LLM.

## US1: 60s Timeout Cuts Hung Wake

**Setup**:
1. Agent settings → Timeout field = `60` seconds
2. Save agent

**Execute**:
1. Assign issue to agent
2. Use model that hangs (never returns output)
3. Click Wake Now
4. Note start time

**Verify (MUST FAIL if not met)**:
- [ ] Run transitions to `failed` at ~60-65 seconds (±5s overhead)
- [ ] `finishedAt - startedAt` ≈ 60 seconds (query `heartbeat_runs`)
- [ ] Error message: `"Heartbeat exceeded wall-clock timeout of 60s"`
- [ ] Error does NOT contain `1200s` or `300s`
- [ ] `lastSeenAt` stopped updating around 60s (does not continue to 20min)

**Database verification**:
```sql
SELECT 
  id,
  status,
  error_text,
  EXTRACT(EPOCH FROM (finished_at - started_at)) as duration_sec,
  last_seen_at
FROM heartbeat_runs
WHERE agent_id = '[agent-id]'
ORDER BY created_at DESC
LIMIT 1;
```

**Critical failure modes**:
- Duration is ~1199s or ~1200s instead of ~60s
- Error says "1200s" while timeout field is 60
- last-seen keeps moving past 60s (stream didn't abort)

## US2: Unset Timeout Defaults to 300s

**Setup**:
1. Create NEW agent OR clear existing timeout
2. Timeout field = empty / `0` / never set
3. Save

**Execute**:
1. Wake agent with hung model
2. Monitor for 5+ minutes

**Verify (MUST FAIL if not met)**:
- [ ] Run fails at ~300-310 seconds
- [ ] Error message: `"Heartbeat exceeded wall-clock timeout of 300s"`
- [ ] Error does NOT contain `1200s` or `60s`
- [ ] `runtimeConfig.timeout.heartbeatSec` in DB is `null` or unset

**Database verification**:
```sql
SELECT 
  name,
  runtime_config->'timeout'->'heartbeatSec' as timeout_config
FROM agents
WHERE url_key = '[agent-urlkey]';
```

Should return `null` or missing field, not `300` (300 is the code default).

**Critical failure modes**:
- Timeout is not 300s (e.g., uses 1200s or never times out)
- Error doesn't say "300s"
- Database has a stored 300 instead of null (config default not used)

## US4: Abort Stops Hung Stream

**Setup**:
1. Agent timeout = 60s
2. Model that generates slowly or hangs completely

**Execute**:
1. Wake agent
2. Watch `lastSeenAt` timestamp on run detail page
3. Note when it stops updating

**Verify (MUST FAIL if not met)**:
- [ ] `lastSeenAt` stops updating at ~60s
- [ ] No LLM streaming continues after 60s
- [ ] If model returns output after 1199s, the wake had already failed at 60s (output ignored)

**Critical failure modes**:
- A 1199s empty generation occurs after 60s timeout (stream ran to completion)
- last-seen keeps updating for 20 minutes
- Wake waits for `durableAgent.stream()` to return instead of aborting

## US6: Force-Kill Returns Before Timeout

**Setup**:
1. Agent timeout = 300s (long timeout)
2. Wake agent with hung model

**Execute**:
1. While run is `running` (before 300s), click **Force Kill** kebab menu
2. Note time of click

**Verify (MUST FAIL if not met)**:
- [ ] Run transitions to `failed` within 1-2 seconds
- [ ] Error message: `"Force-killed by operator"`
- [ ] Does NOT wait for 300s timeout
- [ ] Duration ≈ time between start and force-kill click (not 300s)

**Database verification**:
```sql
SELECT 
  status,
  error_text,
  EXTRACT(EPOCH FROM (finished_at - started_at)) as duration_sec
FROM heartbeat_runs
WHERE id = '[run-id]';
```

**Critical failure modes**:
- Force-kill doesn't take effect (waits for timeout)
- Error is timeout instead of operator kill
- Run continues for 300s despite force-kill

## Test Matrix

| Test | Timeout Config | Expected Duration | Expected Error | Critical Fail |
|------|----------------|-------------------|----------------|---------------|
| US1  | 60s           | ~60s              | "...60s"       | Duration 1200s or error "1200s" |
| US2  | unset (null)  | ~300s             | "...300s"      | Not 300s or error "1200s" |
| US4  | 60s           | ~60s              | last-seen stops| 1199s stream completion |
| US6  | 300s → kill   | <2s               | "Force-killed" | Waits for timeout |

## Smoke Tests (Automated)

`packages/scheduler/src/timeout-production.test.ts`: **3/3 passing**

These verify error extraction logic but **do NOT** test the production wake path:
1. `resolveHeartbeatFailureError` extracts timeout from abort reason
2. Default 300s extracted correctly
3. Operator kill prioritized over timeout

**What smoke tests DO NOT verify**:
- `runWake()` actually sets wall-clock timer
- Abort promise races with `durableAgent.stream()`
- Timeout value read from `runtimeConfig.timeout.heartbeatSec`
- `forceKillHeartbeat()` aborts in-flight run

## Implementation Check

**Wall-clock timer exists** (`wake-runner.ts:445-453`):
```typescript
const timeoutSec = runtimeConfig.timeout?.heartbeatSec ?? 300;
wallClockTimer = setTimeout(() => {
  abortController.abort(new Error(`Heartbeat exceeded wall-clock timeout of ${timeoutSec}s`));
}, timeoutSec * 1000);
```

**Abort promise races** (`wake-runner.ts:765-818`):
```typescript
const abortPromise = new Promise<never>((_, reject) => {
  abortSignal.addEventListener('abort', () => {
    streamResult?.cleanup();
    reject(heartbeatAbortedError());
  }, { once: true });
});

await Promise.race([
  (async () => {
    const streamed = await durableAgent.stream(...);
    await Promise.race([
      streamed.output.text,
      tripwirePromise,
      abortPromise,  // ← Stops waiting for hung stream
    ]);
  })(),
  tripwirePromise,
  abortPromise,
]);
```

**Error extraction works** (`heartbeat-abort.ts:114-125`):
```typescript
if (abortReason instanceof Error && abortReason.message.includes('wall-clock timeout')) {
  return abortReason.message;
}
```

**Manual testing required** to verify these code paths execute correctly with real hung LLM.
