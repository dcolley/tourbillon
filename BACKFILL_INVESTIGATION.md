# Chat Thread Backfill Investigation

**Date:** 2026-10-05  
**Context:** TEST ops dry-run showing 73/89 threads can't infer agent  
**Commit:** 74ddf883 (after #81)

---

## Problem Statement

The `backfill:chat-threads` script reported:
```
Found 89 chat threads
Already tagged 16
Could not infer 73
```

An apply run would tag 0 of the 73 legacy threads, leaving them all in "Older shared chats."

---

## Investigation

### Hypothesis Verification

| Hypothesis | Finding | Status |
|---|---|---|
| No agent message on thread | Irrelevant — messages don't contain agent metadata | ❌ Not the issue |
| resourceId format not parsed | resourceId is company-scoped (`company-{id}:chat:free`) | ✅ Confirmed limitation |
| Metadata JSON shape/keys | Metadata only has `agentId` for new threads (post a9a59c7) | ✅ Root cause |
| Board free-chat vs agent threads | Not a factor — all chat threads use same storage | ❌ Not the issue |

### Key Findings

1. **Commit a9a59c7** (2026-10-05) added `agentId` to thread metadata for NEW threads only
2. **Original backfill script** only checked metadata, not other columns
3. **Thread table has `ownerId` column** with format: `tourbillon-chat-{agentId}` or `tourbillon-chat-{agentId}::{modelId}`
4. **ownerId is set on session creation** via `controller.id` → can be used for inference!

### Code Evidence

```typescript
// packages/mastra/src/chat-controller.ts:94
export function buildChatControllerId(agentId: string, modelId?: string): string {
  const modelKey = modelId?.trim();
  return modelKey
    ? `tourbillon-chat-${agentId}::${modelKey}`
    : `tourbillon-chat-${agentId}`;
}

// apps/web/lib/chat/registry.ts:195
return controller.createSession({
  resourceId,
  id,
  ownerId: controller.id,  // ← This becomes thread.ownerId
  ...
});
```

---

## Solution

Enhanced backfill script to:

1. **Query `ownerId` column** (was missing from original SELECT)
2. **Extract agent ID** using regex: `/^tourbillon-chat-([^:]+)/`
3. **Write to metadata** if inference succeeds
4. **Report stats** (already tagged / inferred / could not infer)

### Example Fix

```typescript
// Before (couldn't infer)
SELECT id, "resourceId", metadata FROM mastra_threads

// After (can infer from ownerId)
SELECT id, "resourceId", metadata, "ownerId" FROM mastra_threads

// Inference logic
if (thread.ownerId) {
  const ownerMatch = thread.ownerId.match(/^tourbillon-chat-([^:]+)/);
  if (ownerMatch) {
    inferredAgentId = ownerMatch[1];
    // Write to metadata
  }
}
```

---

## Expected Outcome

Most of the 73 threads should be inferable if they have valid `ownerId`. Example:

```
Found 89 chat threads
Already tagged: 16
Inferred from ownerId: 70   ← Fixed!
Could not infer: 3          ← Only truly broken threads
```

The 3 remaining un-inferable threads would be:
- Very old threads (created before `ownerId` was added to Mastra storage)
- Corrupted/malformed data
- Test threads with invalid format

**Safe behavior:** Threads that truly can't be inferred remain untagged → appear in "Older shared chats" → auto-tag on first use. No wrong assignments.

---

## Test Coverage

Added `backfill-chat-thread-agent-ids.test.ts` with 7 test cases:
- ✅ Already tagged threads (skip)
- ✅ Standard ownerId format (infer)
- ✅ ownerId with model suffix (infer)
- ✅ Missing ownerId (can't infer)
- ✅ Unexpected format (can't infer)
- ✅ Metadata as text vs JSON
- ✅ Mixed batch processing

---

## Next Steps

### 1. Dry-run on TEST
```bash
DRY_RUN=true pnpm backfill:chat-threads
```

Expected output:
- `Inferred from ownerId: ~70` (most of the 73)
- `Could not infer: ~3` (only truly broken)

### 2. Review Inference Logic

If the dry-run shows good results, the fix is safe to apply.

If many threads still can't infer, investigate:
- Check sample `ownerId` values in TEST DB
- Verify regex pattern matches real data
- Check if Mastra schema changed

### 3. Apply or Document

**Option A: Apply** — if dry-run shows good inference rate  
**Option B: Leave untagged** — if many threads are legitimately un-inferable (e.g., Board admin threads)  
**Option C: Manual tagging** — if specific threads need special handling

---

## Decision

PR #84 is marked **DRAFT** pending:
1. TEST dry-run verification
2. Review of inference logic
3. Decision on apply vs document

**No production changes** — this is a backfill script improvement only.

---

## Files Changed

- `scripts/backfill-chat-thread-agent-ids.ts` — added ownerId inference
- `scripts/backfill-chat-thread-agent-ids.test.ts` — new test suite

---

## References

- **PR #84:** https://github.com/dcolley/tourbillon/pull/84
- **Commit a9a59c7:** Added agent scoping to chat threads (2026-10-05)
- **PR #81:** TEST failures fix (includes backfill metadata parsing)
- **PR #79:** Original backfill script introduction
