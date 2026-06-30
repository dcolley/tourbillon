# SKILL: Buffer Publishing

This skill governs how you schedule social posts via Buffer MCP. Follow every rule here precisely when the `buffer` toolset is enabled.

---

## §1 — Purpose and Prerequisites

Use Buffer to:

- Schedule single posts or multi-post threads on X/Twitter (and other supported platforms)
- Save drafts without consuming posting limits
- Inspect the queue, scheduled posts, and idea pipeline

**Prerequisites:**

- `buffer` toolset enabled on your agent record
- Buffer API key configured at company level (`settings.mcpCredentials['buffer-mcp']`), agent override, or `BUFFER_API_KEY` env
- Buffer MCP tools available at wake time (`get_account`, `list_channels`, `create_post`, etc.)

If Buffer MCP tools are missing at wake, comment on the issue explaining the configuration gap and set status `blocked`. Do not guess channel IDs or fabricate API responses.

---

## §2 — Available MCP Tools

| Tool | Use for |
|---|---|
| `get_account` | Resolve organization IDs |
| `list_channels` / `get_channel` | Find the correct `channelId` for each platform |
| `list_posts` / `get_post` | Inspect queue or scheduled posts |
| `list_ideas` / `list_idea_groups` / `create_idea` | Idea pipeline before committing to queue |
| `create_post` | Schedule a single post or a full thread |
| `edit_post` | Revise a scheduled or draft post |

**Not available** (intentionally blocked): `delete_post`, `execute_mutation`, `execute_query`, analytics tools.

---

## §3 — Setup Workflow (Always Run First)

Before any `create_post` or `edit_post` call:

1. Call `get_account` → note each `organizations[].id` (organizationId).
2. Call `list_channels` with the target organizationId → find the channel for your platform (e.g. Twitter/X) → note `channelId` and `name`.
3. Confirm the channel service type matches the metadata key you will use (`twitter` for X/Twitter, `bluesky`, `threads`, or `mastodon`).

Never reuse a channel ID from a previous heartbeat without confirming it still exists.

---

## §4 — Single Post via `create_post`

| Field | Required | Notes |
|---|---|---|
| `text` | Yes | Post body |
| `channelId` | Yes | From §3 |
| `schedulingType` | Yes | Use `automatic` for normal publishing |
| `mode` | Yes | See §6 |
| `dueAt` | When `mode: customScheduled` | ISO 8601 UTC, e.g. `2026-07-01T09:00:00.000Z` |
| `saveToDraft` | Optional | `true` = save without scheduling; skips posting limits |

Example single-post payload:

```json
{
  "text": "Shipping a new local-first agent feature today.",
  "channelId": "<twitter_channel_id>",
  "schedulingType": "automatic",
  "mode": "addToQueue"
}
```

---

## §5 — Tweet Threads via `create_post`

Threaded posts use the `createPost` mutation shape exposed through MCP `create_post`. The thread contract is strict:

- **Every tweet in the thread — including the first — must appear in `metadata.twitter.thread[]`.**
- **Top-level `text` must exactly match `metadata.twitter.thread[0].text`.**
- The `thread` array is the source of truth; posts publish in order, each replying to the previous.
- Each entry is `{ "text": "..." }`. Optional `assets` per tweet for media attachments.

Example three-tweet thread:

```json
{
  "text": "Hook tweet — must match thread[0].text",
  "channelId": "<twitter_channel_id>",
  "schedulingType": "automatic",
  "mode": "addToQueue",
  "metadata": {
    "twitter": {
      "thread": [
        { "text": "Hook tweet — must match top-level text" },
        { "text": "Second tweet in the thread." },
        { "text": "Third tweet wraps everything up." }
      ]
    }
  }
}
```

### Parsing workspace thread drafts

When content lives in a company workspace file formatted as `## Tweet 1/N`:

1. `readWorkspaceFile` the draft path from the issue or task instructions.
2. Split on `## Tweet` headers.
3. Extract the body text of each block in order (strip Issue/Author/Date metadata lines).
4. Build the `thread` array from those strings.
5. Set top-level `text` to the first entry.
6. Validate each tweet is ≤ 280 characters before calling `create_post`.

For a single-tweet post, you may use either a one-item `thread` array or omit `metadata.twitter.thread` and pass only `text`.

---

## §6 — Scheduling Modes

| Mode / flag | Behaviour | Extra fields |
|---|---|---|
| `mode: addToQueue` | Adds to the next available slot in the posting schedule | — |
| `mode: customScheduled` | Publishes at an exact time | `dueAt` (ISO 8601 UTC) |
| `saveToDraft: true` | Saves without scheduling; does not check posting limits | Post status will be `draft` |

**Recommended workflow for high-visibility content:**

1. `saveToDraft: true` on first `create_post`
2. Set issue to `in_review` for human approval
3. After approval, `edit_post` or create a new scheduled post with `addToQueue` or `customScheduled`

---

## §7 — Multi-Platform Threads

The same thread pattern applies on other platforms — swap the metadata key:

| Platform | Metadata key |
|---|---|
| Twitter/X | `metadata.twitter.thread` |
| Bluesky | `metadata.bluesky.thread` |
| Threads | `metadata.threads.thread` |
| Mastodon | `metadata.mastodon.thread` |

Always match the metadata key to the channel's platform from `list_channels`.

---

## §8 — End-to-End Publishing Procedure

1. **Context** — `getHeartbeatContext` + `getComments` on the checked-out issue.
2. **Draft source** — If content is in the workspace, `readWorkspaceFile`. If in issue comments, use the approved copy from the thread.
3. **Setup** — Run §3 (`get_account` → `list_channels`).
4. **Validate** — Character limits, voice/style rules from workspace `resources/` if referenced by the task.
5. **Publish** — `create_post` with the correct payload (single or thread). Prefer `saveToDraft: true` unless the task explicitly says to queue or schedule.
6. **Log result** — On success, comment on the issue with post `id`, `status`, `dueAt` (if set), and channel name.
7. **Handle errors** — On `MutationError`, comment the error message. Set `blocked` if unrecoverable (wrong channel, auth failure).
8. **Close out** — Set issue status per task instructions (`done`, `in_review`, etc.).

---

## §9 — Content Quality Rules

When workspace voice guides exist (`resources/style.md`, `resources/VOICE-GUIDE.md`, pre-submission checklists), follow them. General X/Twitter rules:

- **280 characters per tweet** — validate before posting.
- **Hook in tweet 1** — bold claim or observation; thread body in tweets 2–N.
- **At most 1 hashtag per tweet** — prefer zero.
- **Links** — Twitter may suppress reach on tweets with links in the hook. Put CTA URLs in a later tweet in the thread, not tweet 1.
- **Specificity** — include real numbers, model names, hardware specs when the brand voice calls for it.
- **No corporate fluff** — write as a practitioner, not a press release.

---

## §10 — Common Mistakes

| Mistake | Fix |
|---|---|
| Only replies in `thread[]`, root tweet omitted | Include tweet 1 in `thread[0]` AND set top-level `text` to match |
| Top-level `text` ≠ `thread[0].text` | Keep them identical |
| LinkedIn `channelId` with `metadata.twitter` | Match metadata key to channel platform |
| Missing `schedulingType` | Always set `schedulingType: automatic` |
| Publishing without §3 setup | Always resolve org + channel IDs first |
| No post ID in issue comment | Always log Buffer post ID and status to the issue thread |
| Thread draft not parsed in order | Preserve `## Tweet 1/N` order when building the array |

---

## §11 — Governance

- Use `in_review` when the task or company policy requires human approval before queueing.
- Use `createApproval` for irreversible or high-visibility publishes when instructed.
- **Issue comments are the record of record** — log every Buffer post ID, scheduling decision, and error in issue comments. Do not rely on Mastra memory for publish history.
