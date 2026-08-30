# Tourbillon Control-Plane MCP Server

This document describes how to connect to the Tourbillon control-plane MCP (Model Context Protocol) server for managing agents and heartbeats without browser cookies.

## Overview

The control-plane MCP server provides ops tools for managing TEST (Test Environment/System) agents, including:
- Listing companies this token can access
- Listing agents with configuration
- Setting agent active/paused status
- Configuring heartbeat timers
- Managing observational memory mode
- Viewing failed heartbeat runs
- Inspecting heartbeat run details and observability events

## Connection Details

### MCP Server URL

```
https://your-tourbillon-instance.com/api/mcp
```

Replace `your-tourbillon-instance.com` with your actual Tourbillon deployment domain.

For local development:
```
http://localhost:3002/api/mcp
```

### Transport

The MCP server supports both synchronous HTTP and streaming SSE:
- **HTTP POST**: Send JSON-RPC requests, receive synchronous responses
- **HTTP GET with Accept: text/event-stream**: Establish SSE stream for async messages

### Authentication

The MCP server requires a company JWT token for authentication.

**Header Name:** `X-Company-Token`

**Token Format:** JWT with payload `{ companyId: "company-uuid" }`

**Signing Secret:** `BETTER_AUTH_SECRET` environment variable (same as mobile auth)

### Example Token Generation

```typescript
import { SignJWT } from 'jose';

const SESSION_SECRET = new TextEncoder().encode(
  process.env.BETTER_AUTH_SECRET
);

const token = await new SignJWT({ companyId: 'your-company-id' })
  .setProtectedHeader({ alg: 'HS256' })
  .setIssuedAt()
  .setExpirationTime('1h')
  .sign(SESSION_SECRET);
```

## Connecting with Grok Bot / SearchPlugins

To add this MCP server to Grok Bot or other MCP clients that support HTTP transport:

1. **Server URL:** `https://your-tourbillon-instance.com/api/mcp`
2. **Transport:** HTTP/SSE (Server-Sent Events)
3. **Authentication:**
   - Type: Custom Header
   - Header Name: `X-Company-Token`
   - Header Value: Your JWT token (generated as shown above)

### Example MCP Client Configuration

```json
{
  "mcpServers": {
    "tourbillon-control-plane": {
      "url": "https://your-tourbillon-instance.com/api/mcp",
      "transport": "http",
      "headers": {
        "X-Company-Token": "your-jwt-token-here"
      }
    }
  }
}
```

## Available Tools

**Note:** All tools except `company_list` require a `company_id` parameter. The token identifies the operator; `company_id` specifies which company to operate on. The token must grant access to the requested company.

### Core Management Tools

### 1. company_list

List companies this token can act as (returns the single company from the JWT).

**Parameters:** None

**Returns:**
- `companies`: Array of company objects
  - `id`: Company UUID
  - `name`: Company name

### 2. list_agents

List all agents in the company with their configuration.

**Parameters:**
- `company_id` (string, required): Company UUID

**Returns:** Array of agent objects with:
- `id`: Agent UUID
- `name`: Agent name
- `urlKey`: Agent URL key
- `modelId`: LLM model ID
- `providerName`: LLM provider name
- `active`: Boolean (true=active, false=paused)
- `heartbeatEnabled`: Boolean
- `heartbeatIntervalSec`: Interval in seconds (or null)
- `heartbeatCronExpression`: Cron schedule (or null)
- `heartbeatScheduleMode`: 'interval' | 'cron' (or null)
- `observationalMemoryMode`: 'inherit' | 'off' | 'on'

### 3. set_agent_active

Set an agent active (true) or paused (false).

**Parameters:**
- `company_id` (string, required): Company UUID
- `agent_id` (string, required): Agent UUID
- `active` (boolean, required): true to activate, false to pause

### 4. set_heartbeat

Configure agent heartbeat timer.

**Parameters:**
- `company_id` (string, required): Company UUID
- `agent_id` (string, required): Agent UUID
- `enabled` (boolean): Enable or disable heartbeat timer
- `interval_sec` (number): Heartbeat interval in seconds (sets scheduleMode to 'interval')
- `cron_expression` (string): Cron schedule (e.g., "0 9 * * 1-5", sets scheduleMode to 'cron')

**Note**: Timer off is achieved by setting `enabled: false`.

### 5. set_om

Set agent observational memory mode.

**Parameters:**
- `company_id` (string, required): Company UUID
- `agent_id` (string, required): Agent UUID
- `mode` (string, required): 'inherit' | 'off' | 'on'
- `provider_id` (string): LLM provider ID (if mode=on)
- `model_id` (string): Model ID (if mode=on)

### 6. list_failed_jobs

List recent failed heartbeat runs with error details.

**Parameters:**
- `company_id` (string, required): Company UUID
- `page` (number): Page number (0-based, default 0)
- `page_size` (number): Items per page (default 25)

**Returns:**
- `entries`: Array of failed heartbeat runs
  - `runId`: Heartbeat run UUID
  - `jobId`: Job ID (if any)
  - `agentName`: Agent name
  - `agentUrlKey`: Agent URL key
  - `modelId`: Model used
  - `providerName`: Provider name
  - `invocationSource`: 'timer' | 'on_demand'
  - `errorText`: Error message
  - `startedAt`: ISO timestamp
  - `finishedAt`: ISO timestamp
- `total`: Total failed runs
- `page`: Current page
- `pageSize`: Page size

### 7. get_heartbeat

Get heartbeat run details including status, agent, model, provider, timing, and token usage.

**Parameters:**
- `company_id` (string, required): Company UUID
- `run_id` (string, required): Heartbeat run UUID

**Returns:**
- `runId`: Heartbeat run UUID
- `status`: 'queued' | 'running' | 'succeeded' | 'failed'
- `agentId`: Agent UUID
- `agentName`: Agent name
- `agentUrlKey`: Agent URL key
- `modelId`: Model identifier
- `providerName`: Provider name
- `invocationSource`: 'timer' | 'on_demand' | 'assignment' | etc.
- `startedAt`: ISO timestamp
- `lastSeenAt`: ISO timestamp (or null)
- `finishedAt`: ISO timestamp (or null)
- `errorText`: Error message (or null)
- `inputTokens`: Input token count (or null)
- `outputTokens`: Output token count (or null)

### 8. list_heartbeat_events

List observability events for a heartbeat run (model steps, tool calls, provider calls, etc.).

**Parameters:**
- `company_id` (string, required): Company UUID
- `run_id` (string, required): Heartbeat run UUID
- `page` (number): Page number (0-based, default 0)
- `page_size` (number): Items per page (default 25)

**Returns:**
- `events`: Array of observability events
  - `id`: Event UUID
  - `occurredAt`: ISO timestamp
  - `eventType`: 'model_step' | 'tool_call' | 'model_inference' | etc.
  - `name`: Event name
  - `status`: 'success' | 'error' | 'in_progress'
  - `durationMs`: Duration in milliseconds (or null)
  - `inputTokens`: Input token count (or null)
  - `outputTokens`: Output token count (or null)
  - `inputPreview`: Input preview text (or null)
  - `outputPreview`: Output preview text (or null)
  - `errorText`: Error message (or null)
  - `errorInfo`: Error details object (or null)
    - `statusCode`: HTTP status code (or null)
    - `url`: API endpoint URL (or null)
    - `responseBody`: Response body text (or null)
    - `firstFrame`: First frame of response (or null)
- `total`: Total event count
- `page`: Current page
- `pageSize`: Page size

### 9. live_heartbeat

Get live snapshot of a heartbeat run (status, timing, logs). Poll this endpoint to monitor run progress.

**Parameters:**
- `company_id` (string, required): Company UUID
- `run_id` (string, required): Heartbeat run UUID

**Returns:**
- `runId`: Heartbeat run UUID
- `status`: 'queued' | 'running' | 'succeeded' | 'failed'
- `state`: Job state ('waiting' | 'active' | 'completed' | 'failed')
- `attemptsMade`: Number of attempts
- `startedAt`: ISO timestamp (or null)
- `lastSeenAt`: ISO timestamp (or null)
- `finishedAt`: ISO timestamp (or null)
- `errorText`: Error message (or null)
- `logs`: Array of log lines
- `logCount`: Total log count

### Issue Management Tools

### 10. list_issues

List issues in the company with optional filters.

**Parameters:**
- `company_id` (string, required): Company UUID
- `status` (string): Filter by status (backlog, todo, in_progress, in_review, done, blocked, cancelled)
- `assignee_agent_id` (string): Filter by assigned agent UUID
- `page` (number): Page number (0-based, default 0)
- `page_size` (number): Items per page (default 25)

**Returns:**
- `issues`: Array of issue objects
  - `id`: Issue UUID
  - `identifier`: Issue identifier (e.g., "PROJ-123")
  - `title`: Issue title
  - `description`: Issue description
  - `status`: Issue status
  - `priority`: Issue priority
  - `assigneeAgentId`: Assigned agent UUID (or null)
  - `goalId`: Goal UUID (or null)
  - `projectId`: Project UUID (or null)
  - `createdAt`: ISO timestamp
  - `updatedAt`: ISO timestamp
- `total`: Total issue count
- `page`: Current page
- `pageSize`: Page size

### 11. get_issue

Get detailed issue information.

**Parameters:**
- `company_id` (string, required): Company UUID
- `issue_id` (string, required): Issue UUID

**Returns:**
- `id`: Issue UUID
- `identifier`: Issue identifier
- `title`: Issue title
- `description`: Issue description
- `status`: Issue status
- `priority`: Issue priority
- `assigneeAgentId`: Assigned agent UUID (or null)
- `goalId`: Goal UUID (or null)
- `projectId`: Project UUID (or null)
- `assignee`: Agent object (or null)
- `goal`: Goal object (or null)
- `project`: Project object (or null)
- `createdAt`: ISO timestamp
- `updatedAt`: ISO timestamp

### 12. create_issue

Create a new issue. Empty creates are rejected.

**Parameters:**
- `company_id` (string, required): Company UUID
- `title` (string, required): Issue title
- `description` (string): Issue description
- `assignee_agent_id` (string): Agent UUID to assign
- `goal_id` (string): Goal UUID
- `project_id` (string): Project UUID
- `priority` (string): Issue priority (critical, high, medium, low; default: medium)

**Returns:**
- `id`: Issue UUID
- `identifier`: Issue identifier
- `title`: Issue title
- `status`: Issue status
- `priority`: Issue priority

### 13. set_issue_status

Set issue status. Halted issues (pending board approval) cannot change status until the board decides.

**Parameters:**
- `company_id` (string, required): Company UUID
- `issue_id` (string, required): Issue UUID
- `status` (string, required): New status (backlog, todo, in_progress, in_review, done, blocked, cancelled)

**Returns:**
- `id`: Issue UUID
- `identifier`: Issue identifier
- `status`: New status

### 14. add_issue_comment

Add a comment to an issue.

**Parameters:**
- `company_id` (string, required): Company UUID
- `issue_id` (string, required): Issue UUID
- `body` (string, required): Comment text

**Returns:**
- `id`: Comment UUID
- `body`: Comment text
- `createdAt`: ISO timestamp

### Goal Management Tools

### 15. list_goals

List goals in the company.

**Parameters:**
- `company_id` (string, required): Company UUID
- `status` (string): Filter by status (active, completed, archived, all; default: all)

**Returns:**
- `goals`: Array of goal objects
  - `id`: Goal UUID
  - `title`: Goal title
  - `description`: Goal description
  - `status`: Goal status
  - `createdAt`: ISO timestamp
  - `updatedAt`: ISO timestamp

### 16. create_goal

Create a new goal.

**Parameters:**
- `company_id` (string, required): Company UUID
- `title` (string, required): Goal title
- `description` (string): Goal description
- `status` (string): Goal status (active, completed, archived; default: active)

**Returns:**
- `id`: Goal UUID
- `title`: Goal title
- `status`: Goal status

### 17. set_goal_status

Set goal status.

**Parameters:**
- `company_id` (string, required): Company UUID
- `goal_id` (string, required): Goal UUID
- `status` (string, required): New status (active, completed, archived)

**Returns:**
- `id`: Goal UUID
- `title`: Goal title
- `status`: New status

### Project Management Tools

### 18. list_projects

List projects in the company.

**Parameters:**
- `company_id` (string, required): Company UUID
- `status` (string): Filter by status (active, paused, completed, archived, all; default: all)
- `goal_id` (string): Filter by goal UUID

**Returns:**
- `projects`: Array of project objects
  - `id`: Project UUID
  - `title`: Project title
  - `description`: Project description
  - `status`: Project status
  - `goalId`: Goal UUID
  - `goalTitle`: Goal title

### 19. create_project

Create a new project.

**Parameters:**
- `company_id` (string, required): Company UUID
- `title` (string, required): Project title
- `description` (string): Project description
- `goal_id` (string, required): Goal UUID (required)
- `status` (string): Project status (active, paused, completed, archived; default: active)

**Returns:**
- `id`: Project UUID
- `title`: Project title
- `status`: Project status
- `goalId`: Goal UUID

### 20. set_project_status

Set project status.

**Parameters:**
- `company_id` (string, required): Company UUID
- `project_id` (string, required): Project UUID
- `status` (string, required): New status (active, paused, completed, archived)

**Returns:**
- `id`: Project UUID
- `title`: Project title
- `status`: New status

### Approval Management Tools

### 21. list_approvals

List pending and recent board approvals.

**Parameters:**
- `company_id` (string, required): Company UUID
- `status` (string): Filter by status (pending, approved, rejected, all; default: pending)
- `limit` (number): Maximum results (default: 50)

**Returns:**
- `approvals`: Array of approval objects
  - `id`: Approval UUID
  - `type`: Approval type
  - `status`: Approval status (pending, approved, rejected)
  - `requestedByAgentId`: Requesting agent UUID
  - `decidedByUserId`: Deciding user ID (or null)
  - `issueIds`: Array of linked issue UUIDs
  - `payload`: Approval payload object
  - `note`: Decision note (or null)
  - `decidedAt`: ISO timestamp (or null)
  - `createdAt`: ISO timestamp

### 22. decide_approval

Decide a pending board approval. Approval restores prior issue status; rejection leaves issues blocked. Issues must be manually cancelled via `set_issue_status` if needed after rejection.

**Parameters:**
- `company_id` (string, required): Company UUID
- `approval_id` (string, required): Approval UUID
- `decision` (string, required): Decision (approved or rejected)
- `reason` (string): Decision reason/note

**Returns:**
- `id`: Approval UUID
- `status`: New status
- `decision`: Decision (approved or rejected)
- `decidedAt`: ISO timestamp

### Agent Wake Tools

### 23. wake_agent

Trigger on-demand agent heartbeat. Returns error if a wake is already in flight for this agent.

**Parameters:**
- `company_id` (string, required): Company UUID
- `agent_id` (string, required): Agent UUID

**Returns:**
- `runId`: Heartbeat run UUID (or null)
- `jobId`: Job ID (or null)
- `message`: Result message

**Errors:**
- Returns "a wake may already be in flight" if another wake is running

## Security

- Each company token is scoped to a single company
- All tools (except `company_list`) require `company_id` argument
- Cross-company access is prevented (company A token cannot access company B resources)
- Invalid or missing tokens return 401 Unauthorized
- Invalid or unauthorized `company_id` values return errors
- All mutations verify agent ownership before applying changes
- No cookie or session-based authentication — all access is via `X-Company-Token` header

## Out of Scope

This MCP server is for ops and control-plane management. The following features are NOT included:
- Chat / DM functionality
- Hiring new agents
- Agent skill/tool configuration
- Runtime adapter changes

For these features, use the web UI or other APIs.
