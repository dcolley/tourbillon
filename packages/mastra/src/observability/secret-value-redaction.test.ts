import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  SpanType,
  TracingEventType,
  type AnyExportedSpan,
  type TracingEvent,
} from '@mastra/core/observability';
import { BaseExporter, Observability } from '@mastra/observability';
import { ROLE_TOOLS } from '../tools/role-tools';
import { withAgentSecretRedaction } from '../tools/redact-tool-output';
import { createHeartbeatRuntimeContext } from '../tools/api-client';
import { buildSpanOutputProcessors } from '../mastra-instance';
import { clearKnownSecretValues, registerKnownSecretValues } from './secret-value-redaction';

/**
 * #100 regression: Cyber called listAgents and received TestSuper's runtimeConfig.secrets
 * values, which were then persisted in observability payloads. Values below are fakes.
 */
const TEST_EMAIL = 'testsuper.fixture@example.invalid';
const TEST_PASSWORD = 'Fixture-Passw0rd-not-real-9f3a';
const COMPANY_ID = 'company-247a7bf2';

const testSuperRow = {
  id: 'agent-testsuper',
  name: 'TestSuper',
  companyId: COMPANY_ID,
  runtimeConfig: {
    heartbeat: { enabled: true },
    secrets: { TEST_EMAIL, TEST_PASSWORD },
  },
};
const cyberRow = {
  id: 'agent-cyber-52a8b6fb',
  name: 'Cyber',
  companyId: COMPANY_ID,
  runtimeConfig: { heartbeat: { enabled: true } },
};

class CapturingExporter extends BaseExporter {
  name = 'capturing-test-exporter';
  readonly ended: AnyExportedSpan[] = [];
  protected async _exportTracingEvent(event: TracingEvent): Promise<void> {
    if (event.type === TracingEventType.SPAN_ENDED) this.ended.push(event.exportedSpan);
  }
}

function heartbeatContext() {
  return createHeartbeatRuntimeContext({
    apiKey: 'run-token',
    runId: 'run-7f82fcb2',
    agentId: cyberRow.id,
    companyId: COMPANY_ID,
    agentRuntimeConfig: cyberRow.runtimeConfig as never,
  });
}

/** Runs the redacted listAgents tool against a server that still returns raw agent rows. */
async function callListAgents(): Promise<unknown> {
  const tools = withAgentSecretRedaction(ROLE_TOOLS.roster) as Record<string, any>;
  return tools.listAgentsTool.execute({}, { requestContext: heartbeatContext() });
}

describe('#100 agent secrets redaction', () => {
  const realFetch = globalThis.fetch;
  let exporter: CapturingExporter;
  let observability: Observability;

  beforeEach(() => {
    clearKnownSecretValues();
    globalThis.fetch = (async () =>
      new Response(JSON.stringify([testSuperRow, cyberRow]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    exporter = new CapturingExporter();
    observability = new Observability({
      configs: {
        default: {
          serviceName: 'tourbillon-test',
          spanOutputProcessors: buildSpanOutputProcessors(),
          exporters: [exporter],
        },
      },
    });
    // What wake-runner does at run start: every company agent's secrets become known values.
    registerKnownSecretValues(`company:${COMPANY_ID}`, [testSuperRow.runtimeConfig, cyberRow.runtimeConfig]);
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    await observability.shutdown();
    clearKnownSecretValues();
  });

  async function exportToolSpan(input: unknown, output: unknown, extra: Record<string, unknown> = {}) {
    const instance = observability.getDefaultInstance();
    assert.ok(instance, 'observability instance');
    const span = instance.startSpan({
      type: SpanType.TOOL_CALL,
      name: "tool: 'listAgents'",
      input,
      attributes: { toolType: 'tool' } as never,
      metadata: { companyId: COMPANY_ID, ...extra },
    } as never);
    span.end({ output } as never);
    await observability.flush();
    const exported = exporter.ended.find((s) => s.id === span.id);
    assert.ok(exported, 'span exported');
    return exported;
  }

  it('listAgents tool result for an agent with secrets has key names only, no values', async () => {
    const result = (await callListAgents()) as Array<{ name: string; runtimeConfig: Record<string, unknown> }>;
    const json = JSON.stringify(result);
    assert.ok(!json.includes(TEST_EMAIL), 'TEST_EMAIL value must not reach the model');
    assert.ok(!json.includes(TEST_PASSWORD), 'TEST_PASSWORD value must not reach the model');
    const testSuper = result.find((a) => a.name === 'TestSuper')!;
    assert.deepEqual(testSuper.runtimeConfig.secrets, { TEST_EMAIL: '[redacted]', TEST_PASSWORD: '[redacted]' });
    assert.deepEqual(testSuper.runtimeConfig.heartbeat, { enabled: true }, 'non-secret config intact');
  });

  it('assembleAgentTools is the choke point: every assembled tool returns redacted runtimeConfig', async (t) => {
    // agent-factory pulls the MCP/vault import chain (@tourbillon/shared → @tourbillon/db), which
    // does not resolve in every local checkout; skip there rather than fake the import.
    let agentFactory: typeof import('../agent-factory');
    try {
      agentFactory = await import('../agent-factory');
    } catch (err) {
      if ((err as { code?: string })?.code !== 'MODULE_NOT_FOUND') throw err;
      t.skip('agent-factory import chain unavailable in this checkout (MODULE_NOT_FOUND)');
      return;
    }
    const tools = (await agentFactory.assembleAgentTools({
      ...cyberRow,
      role: 'ceo',
      urlKey: 'cyber',
      assignedSkills: [],
      assignedToolsets: ['roster'],
      mcpServerIds: [],
      adapterType: 'harness_local',
    } as never)) as Record<string, any>;
    const listed = await tools.listAgentsTool.execute({}, { requestContext: heartbeatContext() });
    const json = JSON.stringify(listed);
    assert.ok(!json.includes(TEST_PASSWORD) && !json.includes(TEST_EMAIL));
    // Same wrapper on tools that are not agent-specific (e.g. getIdentity / search).
    const identity = await tools.getIdentityTool.execute({}, { requestContext: heartbeatContext() });
    assert.ok(!JSON.stringify(identity).includes(TEST_PASSWORD));
  });

  it('observability span for the listAgents call contains no secret values', async () => {
    const result = await callListAgents();
    // Model-input shape as recorded on a generation span; uses the raw (pre-#100) payload so the
    // span processor is exercised even if a secret slipped past tool redaction.
    const rawModelInput = {
      messages: [
        { role: 'user', content: 'wake' },
        { role: 'tool', content: [{ type: 'tool-result', toolName: 'listAgents', output: [testSuperRow] }] },
      ],
    };
    const exported = await exportToolSpan({}, result, { modelInput: rawModelInput });
    const json = JSON.stringify(exported);
    assert.ok(!json.includes(TEST_EMAIL), 'exported span has no TEST_EMAIL value');
    assert.ok(!json.includes(TEST_PASSWORD), 'exported span has no TEST_PASSWORD value');
    assert.ok(json.includes('TEST_EMAIL'), 'key names are kept');
  });

  it('a secret value injected into a tool result is redacted in the exported span', async () => {
    const liveResult = {
      path: 'notes/creds.md',
      content: `login with ${TEST_EMAIL} / ${TEST_PASSWORD} then run checks`,
      nested: [{ text: JSON.stringify({ password: TEST_PASSWORD }) }],
    };
    const exported = await exportToolSpan({ path: 'notes/creds.md' }, liveResult);
    const json = JSON.stringify(exported);
    assert.ok(!json.includes(TEST_EMAIL), 'email value scrubbed');
    assert.ok(!json.includes(TEST_PASSWORD), 'password value scrubbed');
    const output = exported.output as { content: string };
    assert.equal(output.content, 'login with [REDACTED:TEST_EMAIL] / [REDACTED:TEST_PASSWORD] then run checks');
    // The live object handed back to the agent is not mutated by the processor.
    assert.ok(liveResult.content.includes(TEST_PASSWORD));
  });

  it("the running agent's own secrets are registered by createHeartbeatRuntimeContext", async () => {
    clearKnownSecretValues();
    const ownSecret = 'own-agent-secret-value-123';
    createHeartbeatRuntimeContext({
      apiKey: 'k',
      runId: 'r',
      agentId: 'agent-own',
      companyId: COMPANY_ID,
      agentRuntimeConfig: { secrets: { OWN_TOKEN: ownSecret } } as never,
    });
    const exported = await exportToolSpan({}, { stdout: `token=${ownSecret}` });
    assert.deepEqual(exported.output, { stdout: 'token=[REDACTED:OWN_TOKEN]' });
  });

  it('values shorter than the minimum length are not value-scrubbed (false-positive guard)', async () => {
    clearKnownSecretValues();
    registerKnownSecretValues('agent:short', [{ secrets: { PIN: '1234', FLAG: 'true' } }]);
    const exported = await exportToolSpan({}, { text: 'status true, code 1234' });
    assert.deepEqual(exported.output, { text: 'status true, code 1234' });
  });
});
