# SKILL: Code Execution

This skill governs how you write and run code in the isolated execution sandbox. Follow every rule here precisely when the `code-execution` toolset is enabled.

---

## §1 — Purpose and Prerequisites

Use code execution to:

- Write, edit, and run scripts or small programs to complete issue work
- Run tests, linters, or build commands in a scoped working directory
- Iterate on code across multiple tool calls within a heartbeat

**Prerequisites:**

- `code-execution` toolset enabled on your agent record
- Workspace sandbox tools available at wake time (`mastra_workspace_execute_command`, file tools)
- A checked-out issue (sandbox CWD is scoped per company and issue)

If sandbox tools are missing at wake, comment on the issue explaining the configuration gap and set status `blocked`. Do not fabricate command output.

---

## §2 — Two Filesystem Lanes (Do Not Confuse)

| Lane | Tools | Scope | Use for |
|---|---|---|---|
| **Company workspace** | `listWorkspaceFiles`, `readWorkspaceFile`, `writeWorkspaceFile` | Shared company document tree (`COMPANY_WORKSPACE_ROOT`) | Reference docs, drafts, resources — persistent shared files |
| **Execution sandbox** | `mastra_workspace_read_file`, `mastra_workspace_write_file`, `mastra_workspace_edit_file`, `mastra_workspace_execute_command`, etc. | Per-issue scratch directory (`EXECUTION_WORKSPACE_ROOT/{companyId}/{issueId}`) | Code you write and run for the current task |

**Rules:**

- Run shell commands **only** via sandbox tools — never assume host filesystem access outside the sandbox CWD.
- Copy reference material from the company workspace into the sandbox when you need to execute against it.
- Do not store task history only in sandbox files — **issue comments are the record of record**.

---

## §3 — Available Sandbox Tools

| Tool | Use for |
|---|---|
| `mastra_workspace_execute_command` | Run a shell command in the sandbox CWD |
| `mastra_workspace_get_process_output` | Read stdout/stderr from a background process |
| `mastra_workspace_kill_process` | Terminate a background process |
| `mastra_workspace_read_file` | Read a file in the sandbox |
| `mastra_workspace_write_file` | Create or overwrite a file in the sandbox |
| `mastra_workspace_edit_file` | Apply targeted edits to a sandbox file |
| `mastra_workspace_grep` / `mastra_workspace_glob` | Search sandbox files |

Tool names may appear with or without the `mastra_workspace_` prefix depending on runtime — use whichever execute/file tools are present in your tool list.

---

## §4 — Workflow

1. **Checkout** the issue (control-plane §1 step 5).
2. **Orient** — read issue description and comments; use company workspace tools for shared reference docs.
3. **Work in the sandbox** — write code, run commands, inspect output.
4. **Comment checkpoints** — after every material command or file change, add an issue comment with:
   - What you ran or changed (brief)
   - Outcome (success/failure, key output lines)
   - What you will do next
5. **Complete or hand off** — set status per control-plane §2; include paths to important sandbox artifacts in your final comment.

---

## §5 — Safety Rules

- Do not run destructive commands targeting paths outside the sandbox CWD.
- Do not exfiltrate secrets from company workspace or `.env` files into comments.
- Prefer short, inspectable commands over long opaque one-liners.
- If a command hangs, use `mastra_workspace_kill_process` and report the timeout in a comment.
- If the sandbox is unavailable (tool errors, permission denied), set status `blocked` with a clear configuration message.

---

## §6 — Agent vs Harness Runtime

| Runtime | When to use |
|---|---|
| **Agent** | Quick scripts, single-heartbeat tasks, tests |
| **Harness** | Multi-step coding that spans several heartbeats on the same issue — harness threads persist workspace state between wakes |

Harness without `code-execution` cannot edit or execute files (permissions deny). Both runtimes need the toolset for shell access.

---

## §7 — Failure Handling

| Situation | Action |
|---|---|
| Sandbox tools missing | Comment + `blocked` |
| Command failed (non-zero exit) | Comment with stderr; fix and retry or `blocked` if unrecoverable |
| Timeout | Kill process, comment, retry with smaller scope or `blocked` |
| Need human input | `in_review` with comment explaining what you need |
