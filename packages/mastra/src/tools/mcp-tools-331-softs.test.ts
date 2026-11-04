/**
 * S331-5b (#331): buildMCPTools merges each server's listTools() map with Object.assign and NO
 * server-namespace — a tool NAME exposed by two allowed servers is LAST-WRITER-WINS: the last
 * server in resolveAgentMcpServerIds order owns the key and the other tool vanishes before the
 * gated resolver ever sees it (the 409 ambiguous_tool refusal therefore only fires while both
 * tools keep DISTINCT keys). Pinned behaviourally + with a source pin on the merge line.
 *
 * Server definitions come from a temp mcp.json (TOURBILLON_MCP_CONFIG + registry-cache reset);
 * clients come from the S331-5b deps seam, so no sockets and no production behaviour change.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetMcpRegistryCache } from '@tourbillon/shared/mcp-registry';
import { buildMCPTools } from './mcp-tools';

const HERE = dirname(fileURLToPath(import.meta.url));

test('PIN S331-5b: same tool name from two MCP servers ⇒ last-writer-wins; the loser is gone, never ambiguous', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tb-331-mcp-'));
  const cfg = join(dir, 'mcp.json');
  writeFileSync(
    cfg,
    JSON.stringify({
      mcpServers: {
        'alpha-mcp': { url: 'http://127.0.0.1:9/alpha' },
        'beta-mcp': { url: 'http://127.0.0.1:9/beta' },
      },
    }),
  );
  const savedCfg = process.env.TOURBILLON_MCP_CONFIG;
  process.env.TOURBILLON_MCP_CONFIG = cfg;
  resetMcpRegistryCache();
  try {
    const agentRecord = {
      id: 'agent-1',
      companyId: 'company-1',
      urlKey: 'tool-fan',
      mcpServerIds: ['alpha-mcp', 'beta-mcp'],
      runtimeConfig: {},
    } as unknown as Parameters<typeof buildMCPTools>[0];

    const lists: Record<string, Record<string, unknown>> = {
      'alpha-mcp': { sharedTool: { id: 'sharedTool', label: 'alpha' }, alphaOnly: { id: 'alphaOnly' } },
      'beta-mcp': { sharedTool: { id: 'sharedTool', label: 'beta' }, betaOnly: { id: 'betaOnly' } },
    };
    const asked: string[] = [];
    const tools = await buildMCPTools(agentRecord, {
      allowedMcpServerIds: ['alpha-mcp', 'beta-mcp'],
      deps: {
        getMCPClientImpl: async (serverId) => {
          asked.push(serverId);
          return { listTools: async () => lists[serverId] };
        },
      },
    });

    assert.deepEqual(asked, ['alpha-mcp', 'beta-mcp'], 'server iteration order is the merge order');
    assert.deepEqual(Object.keys(tools).sort(), ['alphaOnly', 'betaOnly', 'sharedTool']);
    assert.equal((tools.sharedTool as { label?: string }).label, 'beta', 'LAST server owns the shared key');
    // The alpha copy of the shared name is truly GONE (no namespaced escape hatch, no second key):
    const shared = Object.values(tools).filter((t) => (t as { id?: string }).id === 'sharedTool');
    assert.equal(shared.length, 1, 'exactly one sharedTool entry survives — the loser vanished entirely');
    assert.equal((shared[0] as { label?: string }).label, 'beta', 'the survivor is the LAST server copy');
  } finally {
    if (savedCfg === undefined) delete process.env.TOURBILLON_MCP_CONFIG;
    else process.env.TOURBILLON_MCP_CONFIG = savedCfg;
    resetMcpRegistryCache();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PIN S331-5b SOURCE: cross-server merge stays the un-namespaced Object.assign (first-writer-wins / prefixing revert to RED here)', () => {
  const src = readFileSync(join(HERE, 'mcp-tools.ts'), 'utf8');
  const body = src.slice(src.indexOf('export async function buildMCPTools'));
  assert.match(body, /Object\.assign\(\s*tools,\s*filtered\s*\)/);
  // No server-namespacing of keys and no first-writer guard may silently replace the pin above.
  assert.doesNotMatch(body, /tools\[[^\]]*serverId[^\]]*\]\s*=/);
  assert.doesNotMatch(body, /if\s*\(\s*!\s*\(?\s*[a-zA-Z_]+\s+in\s+tools\s*\)?\s*\)/);
});
