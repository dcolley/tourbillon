// ============================================================================
// TOUR-116: Integrations Dashboard — Unified Status API
// 
// GET    /api/integrations  - Returns aggregated status of all integrations
// ============================================================================

import { NextResponse } from 'next/server';

export interface IntegrationStatus {
  id: string;
  type: 'slack' | 'github' | 'google';
  connected: boolean;
  name?: string;
  details?: Record<string, unknown>;
  status: 'active' | 'inactive' | 'disconnected';
}

// In-memory store for integration state (replace with DB queries in production)
const slackConnections = new Map<string, { teamId: string; teamName: string; channels: string[] }>();
const githubConnections = new Map<string, { username: string; repos: string[] }>();
const googleConnections = new Map<string, { primaryDomain: string }>();

/**
 * GET - Return aggregated integration status for all connected services.
 */
export async function GET(): Promise<NextResponse> {
  try {
    const integrations: IntegrationStatus[] = [];

    // Slack connections
    const slackList = Array.from(slackConnections.entries());
    if (slackList.length > 0) {
      for (const [id, conn] of slackList) {
        integrations.push({
          id,
          type: 'slack',
          connected: true,
          name: conn.teamName || `Team ${conn.teamId}`,
          details: { channels: conn.channels },
          status: 'active',
        });
      }
    } else {
      integrations.push({
        id: 'slack',
        type: 'slack',
        connected: false,
        name: 'Slack',
        details: {},
        status: 'disconnected',
      });
    }

    // GitHub connections
    const githubList = Array.from(githubConnections.entries());
    if (githubList.length > 0) {
      for (const [id, conn] of githubList) {
        integrations.push({
          id,
          type: 'github',
          connected: true,
          name: conn.username || 'GitHub Account',
          details: { repositories: conn.repos },
          status: 'active',
        });
      }
    } else {
      integrations.push({
        id: 'github',
        type: 'github',
        connected: false,
        name: 'GitHub',
        details: {},
        status: 'disconnected',
      });
    }

    // Google connections
    const googleList = Array.from(googleConnections.entries());
    if (googleList.length > 0) {
      for (const [id, conn] of googleList) {
        integrations.push({
          id,
          type: 'google',
          connected: true,
          name: conn.primaryDomain || 'Google Account',
          details: {},
          status: 'active',
        });
      }
    } else {
      integrations.push({
        id: 'google',
        type: 'google',
        connected: false,
        name: 'Google',
        details: {},
        status: 'disconnected',
      });
    }

    const connectedCount = integrations.filter((i) => i.connected).length;

    return NextResponse.json({
      integrations,
      summary: {
        total: integrations.length,
        connected: connectedCount,
        disconnected: integrations.length - connectedCount,
      },
    });
  } catch (error) {
    console.error('[INTEGRATIONS API] Error fetching integration status:', error);
    return NextResponse.json(
      { error: 'Failed to fetch integration status' },
      { status: 500 }
    );
  }
}

/**
 * POST - Connect an integration (for demo purposes).
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body = await request.json();
    const { type, name, details }: { type: 'slack' | 'github' | 'google'; name?: string; details?: Record<string, unknown> } = body;

    if (!type || !['slack', 'github', 'google'].includes(type)) {
      return NextResponse.json(
        { error: 'Invalid integration type. Must be slack, github, or google.' },
        { status: 400 }
      );
    }

    const id = `${type}_${Date.now()}`;

    if (type === 'slack') {
      slackConnections.set(id, {
        teamId: name?.replace(/\s+/g, '_').toLowerCase() || `team_${id}`,
        teamName: name || 'Demo Team',
        channels: details?.channels ? [details.channels] : ['#general'],
      });
    } else if (type === 'github') {
      githubConnections.set(id, {
        username: name || 'demo-user',
        repos: details?.repositories ? [details.repositories] : ['tourbillon-core'],
      });
    } else if (type === 'google') {
      googleConnections.set(id, {
        primaryDomain: name || 'example.com',
      });
    }

    console.log(`[INTEGRATIONS API] Connected ${type} integration: ${id}`);

    return NextResponse.json({
      message: `${type.charAt(0).toUpperCase() + type.slice(1)} connected successfully`,
      id,
      type,
      name,
    }, { status: 201 });
  } catch (error) {
    console.error('[INTEGRATIONS API] Error connecting integration:', error);
    return NextResponse.json(
      { error: 'Failed to connect integration' },
      { status: 500 }
    );
  }
}

/**
 * DELETE - Disconnect an integration.
 */
export async function DELETE(request: Request): Promise<NextResponse> {
  try {
    const body = await request.json();
    const { id }: { id: string } = body;

    if (!id) {
      return NextResponse.json(
        { error: 'Integration ID is required' },
        { status: 400 }
      );
    }

    // Remove from all stores
    let removed = false;
    for (const key of slackConnections.keys()) {
      if (key === id || key === `${id}`) {
        slackConnections.delete(key);
        removed = true;
      }
    }
    for (const key of githubConnections.keys()) {
      if (key === id || key === `${id}`) {
        githubConnections.delete(key);
        removed = true;
      }
    }
    for (const key of googleConnections.keys()) {
      if (key === id || key === `${id}`) {
        googleConnections.delete(key);
        removed = true;
      }
    }

    // Also support type-based removal: e.g., DELETE with { type: 'slack' } removes all slack connections
    const { type }: { type?: string } = body;
    if (type) {
      if (type === 'slack') {
        removed = true;
        slackConnections.clear();
      } else if (type === 'github') {
        removed = true;
        githubConnections.clear();
      } else if (type === 'google') {
        removed = true;
        googleConnections.clear();
      }
    }

    if (!removed) {
      return NextResponse.json(
        { error: `Integration "${id}" not found` },
        { status: 404 }
      );
    }

    console.log(`[INTEGRATIONS API] Disconnected integration: ${id}`);

    return NextResponse.json({ message: 'Integration disconnected successfully' });
  } catch (error) {
    console.error('[INTEGRATIONS API] Error disconnecting integration:', error);
    return NextResponse.json(
      { error: 'Failed to disconnect integration' },
      { status: 500 }
    );
  }
}
