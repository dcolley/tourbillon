# Agent Timeout Enforcement Test Plan

This document contains executable test procedures to verify that `timeout.heartbeatSec` enforces a wall-clock abort.

## Prerequisites

1. Tourbillon running locally (web + workers)
2. LM Studio running with a model loaded
3. Database accessible
4. At least one active agent configured

## Test Setup

### Create Test Agent (if needed)

```bash
# Via UI at http://localhost:3002/dashboard/agents
# Or use existing agent and temporarily modify timeout
```

## US1: 60s timeout, hang generation, fail at ~60s with error quoting 60s

### Setup
1. Go to agent settings: http://localhost:3002/dashboard/agents/[agent-urlKey]
2. Set **Timeout (seconds)** to `60`
3. Save

### Execute
1. Create a new issue and assign to the agent
2. **Immediately before clicking Wake Now**, prepare to monitor:
   - Start time (note the seconds)
   - `/jobs` page: http://localhost:3002/jobs
   - Heartbeat run detail page when it appears

3. Click **Wake Now**

### Verify (MUST FAIL if not met)
- [ ] Run transitions to `failed` at approximately 60-65 seconds (±5s for overhead)
- [ ] Error message is **exactly**: `Heartbeat exceeded wall-clock timeout of 60s`
- [ ] Error message does NOT contain `1200s` or `300s` or any other timeout value
- [ ] `finishedAt - startedAt` ≈ 60 seconds (check in DB or UI)
- [ ] `lastSeenAt` stopped updating around 60s (does not keep moving to 20min)

**Test fails if:**
- Duration is ~300s or ~1200s instead of ~60s
- Error message says "1200s" while timeout field is 60
- last-seen keeps moving past 60s

## US2: Omitted timeout, fail at 300s with error quoting 300s

### Setup
1. Create a NEW agent (or clear existing agent's timeout config)
2. In agent settings, **leave Timeout field empty** or set to `0` to use default
3. Save

### Execute
1. Assign issue and click Wake Now
2. Monitor for ~5 minutes

### Verify (MUST FAIL if not met)
- [ ] Run transitions to `failed` at approximately 300-305 seconds
- [ ] Error message is: `Heartbeat exceeded wall-clock timeout of 300s`
- [ ] Error message does NOT contain `1200s` or `60s`
- [ ] Duration ≈ 300 seconds

**Test fails if:**
- Timeout is not 300s (e.g., uses 1200s or never times out)
- Error message doesn't say "300s"

## US3: Saved timeout value is actually used

### Setup
1. Set agent timeout to `90` seconds
2. Save
3. Verify in DB:
   ```sql
   SELECT 
     name,
     "runtimeConfig"->'timeout'->'heartbeatSec' as timeout_sec
   FROM agents 
   WHERE url_key = '[your-agent-urlkey]';
   ```
   Should return `90`

### Execute
1. Wake agent with assigned issue

### Verify (MUST FAIL if not met)
- [ ] Run fails at ~90 seconds
- [ ] Error message: `Heartbeat exceeded wall-clock timeout of 90s`
- [ ] NOT 60s, NOT 300s, NOT 1200s

**Test fails if:**
- Stored value is 90 but abort uses a different value
- Error message doesn't match stored value

## US4: On timeout, stream stops and last-seen stops updating

### Setup
1. Set agent timeout to `60` seconds
2. Open browser DevTools Network tab on `/jobs` page
3. Filter for SSE/websocket connections

### Execute
1. Wake agent
2. Watch the `lastSeenAt` timestamp on the run detail page
3. Note when it stops updating

### Verify (MUST FAIL if not met)
- [ ] `lastSeenAt` stops updating at approximately 60 seconds
- [ ] `lastSeenAt` does NOT continue moving for 20 minutes
- [ ] No LLM streaming continues after timeout fires
- [ ] Ping interval stops sending updates after timeout

**Test fails if:**
- A 1199s empty generation occurs after 60s timeout
- last-seen keeps moving past timeout

## US5: Mastra adapter honors the same field

### Setup
1. Create or select an agent with `adapterType: lmstudio` (NOT harness_local)
2. Set timeout to `60` seconds
3. Save

### Execute
1. Wake agent

### Verify (MUST FAIL if not met)
- [ ] Durable/mastra agent path respects the 60s timeout
- [ ] Same error message format: `Heartbeat exceeded wall-clock timeout of 60s`
- [ ] Behavior identical to harness path

**Test fails if:**
- Harness works but durable/mastra doesn't timeout
- Different timeout behavior between adapters

## US6: Force-kill marks run failed immediately

### Setup
1. Set agent timeout to `300` seconds (long timeout)
2. Wake agent

### Execute
1. While run is in-progress (before timeout), click **Force Kill** kebab menu
2. Note the time of click

### Verify (MUST FAIL if not met)
- [ ] Run transitions to `failed` **immediately** (within 1-2 seconds)
- [ ] Error message: `Force-killed by operator`
- [ ] Does NOT wait for 300s timeout
- [ ] Stream stops immediately
- [ ] last-seen stops updating immediately

**Test fails if:**
- Force-kill doesn't take effect (waits for timeout)
- Error message is timeout instead of operator kill

## Test Matrix Summary

| Test | Timeout Config | Expected Duration | Expected Error Message | Critical Check |
|------|----------------|-------------------|------------------------|----------------|
| US1  | 60s           | ~60s              | "...60s"               | Not 1200s |
| US2  | unset         | ~300s             | "...300s"              | Not 1200s |
| US3  | 90s (stored)  | ~90s              | "...90s"               | Matches DB |
| US4  | 60s           | ~60s              | last-seen stops        | No 1199s hang |
| US5  | 60s (mastra)  | ~60s              | "...60s"               | Both adapters |
| US6  | 300s (kill)   | <2s               | "Force-killed..."      | Immediate |

## Database Queries for Verification

```sql
-- Check timeout config
SELECT 
  id,
  name,
  url_key,
  adapter_type,
  ("runtimeConfig"->'timeout'->>'heartbeatSec')::int as timeout_sec
FROM agents;

-- Check run durations and errors
SELECT 
  id,
  agent_id,
  status,
  error_text,
  EXTRACT(EPOCH FROM (finished_at - started_at)) as duration_sec,
  started_at,
  finished_at,
  last_seen_at
FROM heartbeat_runs
WHERE created_at > NOW() - INTERVAL '1 hour'
ORDER BY created_at DESC
LIMIT 20;
```

## Automated Test Helper

```bash
# Run unit tests
cd /workspace/packages/scheduler
pnpm test src/timeout-enforcement.test.ts

# Should output:
# tests 7
# pass 7
# fail 0
```
