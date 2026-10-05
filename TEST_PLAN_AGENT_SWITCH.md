# Test Plan: Agent Chat Session Switching

## Background

This test plan covers the fix for the "Older shared chats" header visibility bug discovered on TEST (October 5, 2026).

**Issue**: When an agent has 0 own threads but >0 shared (untagged) threads, the shared threads list renders WITHOUT the "Older shared chats" header, making it appear as if they are the agent's own threads.

**Fix**: Always show the "Older shared chats" header when `sharedThreads.length > 0`, regardless of whether the agent has own threads.

## Test Environment Setup

### Prerequisites

- Demo company with 73 untagged chat threads (created before PR #78)
- At least 3 agents configured: CEO, COO, CTO
- Board chat panel open in sidebar mode

### Test Data Setup

1. As CEO, create 1-2 new chat threads (these will be tagged with `agentId: <CEO-id>`)
2. COO and CTO should have 0 own threads
3. 73 untagged threads should exist in the database (legacy threads without agentId)

## Manual Test Cases

### Test Case 1: Agent with Own Threads + Shared Threads (CEO)

**Steps:**
1. Open Board chat panel (sidebar mode)
2. Select CEO from agent dropdown
3. Expand the Sessions panel (click the panel icon)

**Expected Result:**
- CEO's own threads appear first (newest to oldest)
- Border separator line
- **"Older shared chats"** header (muted text)
- Untagged shared threads appear below (muted text, newest to oldest)

**Pass Criteria:**
- ✅ "Older shared chats" header is visible
- ✅ Own threads and shared threads are visually separated
- ✅ Own threads have normal text color
- ✅ Shared threads have muted text color

---

### Test Case 2: Agent with Only Shared Threads (COO)

**Steps:**
1. Open Board chat panel (sidebar mode)
2. Select COO from agent dropdown
3. Expand the Sessions panel

**Expected Result:**
- No own threads section
- **"Older shared chats"** header (muted text) - **THIS IS THE FIX**
- Untagged shared threads appear (muted text, newest to oldest)

**Pass Criteria:**
- ✅ "Older shared chats" header is visible (FIXED: was missing before)
- ✅ Shared threads have muted text color
- ✅ No empty "No sessions yet" message

---

### Test Case 3: Agent with Only Shared Threads (CTO)

**Steps:**
1. Open Board chat panel (sidebar mode)
2. Select CTO from agent dropdown
3. Expand the Sessions panel

**Expected Result:**
- Same as Test Case 2 (COO)

**Pass Criteria:**
- ✅ "Older shared chats" header is visible
- ✅ Same untagged threads visible as in COO (shared across all agents)
- ✅ Shared threads have muted text color

---

### Test Case 4: Agent Switching Preserves Correct State

**Steps:**
1. Start with CEO selected (has own threads + shared threads)
2. Note the thread list
3. Switch to COO (only shared threads)
4. Verify COO's thread list
5. Switch back to CEO
6. Verify CEO's thread list again

**Expected Result:**
- After switching to COO: Only shared threads visible with "Older shared chats" header
- After switching back to CEO: Own threads + shared threads visible, correctly grouped
- No stale threads from other agents

**Pass Criteria:**
- ✅ Switching agents correctly refetches thread list
- ✅ "Older shared chats" header appears in both cases
- ✅ CEO's own threads DO NOT appear in COO's list
- ✅ Shared threads appear in both lists

---

### Test Case 5: Sending Message Tags Shared Thread to Current Agent

**Steps:**
1. Select COO
2. Select a shared (untagged) thread from "Older shared chats"
3. Send a message in that thread
4. Switch to CEO
5. Check if that thread still appears in CEO's shared list

**Expected Result:**
- After sending message as COO, the thread gets tagged with `agentId: <COO-id>`
- Thread moves from "Older shared chats" to COO's own threads (on next load)
- Thread no longer appears in CEO's shared list

**Pass Criteria:**
- ✅ Thread gets tagged to COO after first message
- ✅ Thread moves to COO's own threads section
- ✅ Thread no longer appears as shared for other agents

---

## Backend Verification (Optional)

To verify the backend is correctly filtering threads:

```bash
# Check untagged threads in database
psql $DATABASE_URL -c "
  SELECT COUNT(*) as untagged_count
  FROM \"tourbillon-chat-threads_memory_threads\"
  WHERE metadata->>'agentId' IS NULL;
"

# Check CEO's tagged threads
psql $DATABASE_URL -c "
  SELECT id, metadata->>'title' as title, metadata->>'agentId' as agent_id
  FROM \"tourbillon-chat-threads_memory_threads\"
  WHERE metadata->>'agentId' = '<CEO-agent-id>'
  ORDER BY updated_at DESC;
"
```

---

## Regression Tests

Ensure existing functionality still works:

1. ✅ Creating a new thread tags it with current agent
2. ✅ Renaming a thread works
3. ✅ Deleting a thread works
4. ✅ Switching between chat layout modes (fab, popover, sidebar) works
5. ✅ Sending messages in own threads works
6. ✅ SSE stream reconnects work

---

## Known Behavior (Not Bugs)

1. **All agents see the same untagged (shared) threads** - This is expected. Untagged threads are legacy threads from before PR #78. They cannot be reliably tagged to specific agents because the Mastra storage schema does not record agent identity in thread metadata.

2. **Backfill script cannot tag existing threads** - The `scripts/backfill-chat-thread-agent-ids.ts` script will report that it cannot infer agent IDs for existing threads. This is expected and documented in PR #78.

3. **Shared threads become owned on first message** - This is by design. When a user sends their first message in a shared thread, it gets tagged to the current agent and moves to their "own threads" section.

---

## Success Criteria for TEST Live Deployment

- ✅ "Older shared chats" header appears for agents with 0 own threads + >0 shared threads
- ✅ Agent dropdown switching correctly refetches agent-scoped thread lists
- ✅ CEO threads do not appear in COO/CTO lists (only shared/untagged threads appear)
- ✅ No visual regression in chat UI
- ✅ No console errors in browser DevTools
- ✅ Type checks pass: `pnpm type-check`
- ✅ Lint passes: `pnpm lint`
