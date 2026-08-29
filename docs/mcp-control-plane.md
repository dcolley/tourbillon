# Tourbillon Control-Plane MCP Server

This document describes how to connect to the Tourbillon control-plane MCP (Model Context Protocol) server for managing agents and heartbeats without browser cookies.

## Overview

The control-plane MCP server provides ops tools for managing TEST (Test Environment/System) agents, including:
- Listing agents with configuration
- Setting agent active/paused status
- Configuring heartbeat timers
- Managing observational memory mode
- Viewing failed heartbeat runs

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

### 1. list_agents

List all agents in the company with their configuration.

**Returns:**
- `id`: Agent UUID
- `name`: Agent name
- `urlKey`: Agent URL key
- `modelId`: LLM model ID
- `providerName`: LLM provider name
- `active`: Boolean (true=active, false=paused)
- `heartbeatEnabled`: Boolean
- `heartbeatIntervalSec`: Interval in seconds (or null)
- `heartbeatCron`: Cron schedule (or null)
- `observationalMemoryMode`: 'inherit' | 'off' | 'on'

### 2. set_agent_active

Set an agent active (true) or paused (false).

**Parameters:**
- `agentId` (string, required): Agent UUID
- `active` (boolean, required): true to activate, false to pause

### 3. set_agent_heartbeat

Configure agent heartbeat timer.

**Parameters:**
- `agentId` (string, required): Agent UUID
- `enabled` (boolean): Enable or disable heartbeat timer
- `intervalSec` (number): Heartbeat interval in seconds
- `cron` (string): Cron schedule (e.g., "0 9 * * 1-5")

### 4. set_agent_observational_memory

Set agent observational memory mode.

**Parameters:**
- `agentId` (string, required): Agent UUID
- `mode` (string, required): 'inherit' | 'off' | 'on'
- `providerId` (string): LLM provider ID (if mode=on)
- `modelId` (string): Model ID (if mode=on)

### 5. list_failed_heartbeats

List recent failed heartbeat runs with error details.

**Parameters:**
- `page` (number): Page number (0-based, default 0)
- `pageSize` (number): Items per page (default 25)

**Returns:**
- `entries`: Array of failed heartbeat runs
  - `runId`: Heartbeat run UUID
  - `jobId`: Job ID (if any)
  - `agentName`: Agent name
  - `agentUrlKey`: Agent URL key
  - `modelId`: Model used
  - `providerName`: Provider name
  - `invocationSource`: 'timer' | 'on-demand'
  - `errorText`: Error message
  - `startedAt`: ISO timestamp
  - `finishedAt`: ISO timestamp
- `total`: Total failed runs
- `page`: Current page
- `pageSize`: Page size

## Security

- Each company token is scoped to a single company
- Cross-company access is prevented (company A cannot list or mutate company B agents)
- Invalid or missing tokens return 401 Unauthorized
- All mutations verify agent ownership before applying changes

## Out of Scope

This MCP server is for ops tools only. The following features are NOT included:
- Chat / DM functionality
- Wake / on-demand agent invocation
- Hiring new agents
- HITLy (Human-in-the-Loop) approvals

For these features, use the web UI or other APIs.
