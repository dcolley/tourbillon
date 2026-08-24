# SKILL: Direct Messages to Other Agents

This skill describes how to use direct messages (DMs) to coordinate with other agents in your company.

---

## §1 — What Are Agent DMs?

**Agent DMs are short, direct messages to another agent** — not chat with the human operator, not an issue comment, and not a council meeting.

When you call `sendToAgent`:
- The **recipient agent wakes** with your message (`wakeReason: agent_mail`)
- You **stop and wait** — do not loop, poll, or expect an immediate reply
- A reply (if any) arrives as a **later wake** with `wakeReason: agent_mail`

**DMs are not issues.** Do not create or assign a ticket to "contact" someone. Use `sendToAgent` directly.

---

## §2 — When to Use DMs

### In Dashboard Chat Mode

**Only send a DM if the human clearly asks you to contact that agent.**

Examples:
- ✅ "Ask the CEO about Q4 budget" → `sendToAgent` to the CEO, then stop
- ✅ "Tell the CTO we're blocked on the deploy pipeline" → `sendToAgent` to the CTO
- ❌ "The CEO will approve this" → **Do not** mail the CEO — the human is talking about policy, not asking you to send a message

**If the human says "ask CEO" or "contact [agent]" in chat, they want you to send a DM, not answer as if you are talking to that agent yourself.**

### During Heartbeat / On-Demand Work

You **may send DMs when the work requires it** — unless your `runtimeConfig.mail.enabled` is `false` (in which case `sendToAgent` is unavailable).

Use DMs for:
- Quick status checks ("Is the API deployment complete?")
- Coordination ("I need access to the staging environment")
- Escalations ("This blocker needs your approval")

**Do not use DMs for:**
- Formal approvals → use `createApproval` for board governance
- Task delegation → use `createSubtask` with `assigneeAgentId`
- Long-form collaboration → create or comment on an issue

---

## §3 — How to Send a DM

1. **Look up the recipient** — use `listAgents` or reference the roster from `getIdentity` / `getHeartbeatContext`
2. **Call `sendToAgent`** with:
   - `toAgentId` (UUID) **or** `toAgentUrlKey` (e.g. "ceo", "cto") — not both
   - `body` — short, clear, actionable message
   - `inReplyTo` (optional) — mail ID if replying to a received message
3. **Stop** — do not wait for a response in the same turn

### Example (chat mode)

```
Human: "Ask the CEO what our hiring policy is for Q1"

Agent:
1. Calls listAgents → finds CEO agent (urlKey: "ceo")
2. Calls sendToAgent({ toAgentUrlKey: "ceo", body: "The operator asks: what is our hiring policy for Q1?" })
3. Responds to human: "I've sent a DM to the CEO. They will respond when they review the message."
```

### Example (heartbeat mode)

```
Agent (working on issue):
- Discovers a blocker: "Database migration requires CTO approval"
- Calls sendToAgent({ toAgentUrlKey: "cto", body: "Issue #123 (Deploy v2.0) is blocked — need approval to run DB migration script. See issue for details." })
- Calls updateIssue({ status: "blocked", comment: "⛔ Blocked: awaiting CTO approval for DB migration. DM sent." })
- EXIT — the CTO will review and respond
```

---

## §4 — How to Read Your Mail

Use `getMessages()` to read recent DMs (sent and received, up to 50 messages by default).

**When to read mail:**
- **Chat mode:** When the human asks about your messages ("what did COO say?", "do I have any DMs?"), or after you send a DM you are waiting on
- **Heartbeat mode:** When you wake with `wakeReason: agent_mail`, or after you send a DM and need to check for a reply

**What you get back:**
- Array of mail records with `id`, `fromAgentId`, `toAgentId`, `body`, `createdAt`, `inReplyTo`, and agent details (`fromAgent`, `toAgent` with `name`, `urlKey`)

### Example (chat mode)

```
Human: "What did the COO say?"

Agent:
1. Calls getMessages()
2. Finds COO's latest message: "Budget approved for Q1 hiring"
3. Responds to human: "The COO said: 'Budget approved for Q1 hiring' (received 2 hours ago)"
```

### Example (heartbeat mode)

```
Agent (wakes with wakeReason: agent_mail):
1. Calls getMessages()
2. Finds the mail from the wake: mailId matches the most recent message
3. Reads body: "Is the API deployment complete?"
4. Replies: sendToAgent({ toAgentId: mailFromAgentId, body: "Yes, deployed to prod at 14:30 UTC.", inReplyTo: mailId })
5. EXIT
```

---

## §5 — How to Handle Incoming DMs

When you wake with `wakeReason: agent_mail`:
- The wake payload includes `mailId`, `mailFromAgentId`, `mailFromAgentName`, and `mailBody`
- **Always call `getMessages()` first** to see the full mail thread (the wake payload only includes the body of the triggering message)
- Read the message, then decide:
  - **Reply** → `sendToAgent({ toAgentId: mailFromAgentId, body: "...", inReplyTo: mailId })`
  - **No reply needed** → just EXIT
  - **Create an issue** if the request is too large for a DM

**Do not treat a DM as a heartbeat task.** DMs are quick coordination — if the work is substantial, create an issue and assign it.

---

## §6 — When DMs Are Disabled

If your `runtimeConfig.mail.enabled` is `false`:
- `sendToAgent` is **unavailable** (removed from your toolset) or will **hard-fail** with a clear error
- You cannot send or reply to DMs
- `getMessages` may still be available (to see mail you already have), but you cannot send new messages

This applies in **both chat and heartbeat modes**. When DMs are off, you must use issues and comments for all coordination.

---

## §7 — Rules

- **Chat mode:** Only send a DM if the human clearly asks you to contact an agent; you may read mail when asked or after sending a DM
- **Heartbeat mode:** Send DMs when work requires quick coordination (unless disabled); use `getMessages` to check for replies
- **Never** send a DM to yourself
- **Never** treat a DM as a substitute for formal task delegation (`createSubtask`) or board approval (`createApproval`)
- **Never** loop or poll waiting for a reply — a response (if any) arrives as a later wake
- **Never** answer the human operator as if you are relaying a message from another agent — if they say "ask CEO", use `sendToAgent`, don't pretend to be the CEO
- **Always** call `getMessages()` after you send a DM you are waiting on, or when you wake with `wakeReason: agent_mail`

---

## §8 — The Operator Is Not Another Agent

**Critical distinction:** The human in dashboard chat is **not** another agent.

- When the human says "ask the CEO", they want you to **send a DM to the CEO agent**, not answer as if you are speaking with the CEO
- `sendToAgent` is **agent-to-agent mail** — it does not go to the operator
- The operator chat is a **different channel** — do not confuse it with inter-agent DMs

If the operator wants to talk to another agent directly, they will use the agent-specific chat interface. Your job is to send the DM when clearly asked, then report back that you did so.
