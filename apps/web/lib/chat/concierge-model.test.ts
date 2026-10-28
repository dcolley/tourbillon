import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildChatControllerOptions, hasExplicitChatModel, resolveChatModelOptions } from './concierge-model';
import type { ThreadProviderDeps } from './thread-model';

/**
 * CONCIERGE-MODEL-1: resolve-path tests with an injected provider check (no DB, no live
 * Postgres): set / unset / provider disabled or missing → fall back safely.
 */

const COMPANY = 'company-1';

const deps = (available: boolean): ThreadProviderDeps => ({
  isProviderAvailable: async () => available,
});

const pair = { providerId: 'prov-1', modelId: 'snappy-mini' };

describe('CONCIERGE-MODEL-1 — resolveChatModelOptions', () => {
  it('uses the company pair while its provider is on', async () => {
    const opts = await resolveChatModelOptions(
      COMPANY,
      { conciergeModel: pair },
      undefined,
      deps(true),
    );
    assert.deepEqual(opts, { modelIdOverride: 'snappy-mini', providerIdOverride: 'prov-1' });
  });

  it('leaves the agent model alone when the pair is unset or incomplete', async () => {
    assert.equal(await resolveChatModelOptions(COMPANY, {}, undefined, deps(true)), undefined);
    assert.equal(
      await resolveChatModelOptions(
        COMPANY,
        { conciergeModel: { modelId: 'snappy-mini' } },
        undefined,
        deps(true),
      ),
      undefined,
    );
    assert.equal(
      await resolveChatModelOptions(
        COMPANY,
        { conciergeModel: { providerId: 'prov-1' } },
        undefined,
        deps(true),
      ),
      undefined,
    );
  });

  it('falls back to the agent model when the provider is off or missing', async () => {
    // deps(false) models BOTH "switched off" and "no such provider" (isThreadProviderAvailable
    // returns false for either).
    const opts = await resolveChatModelOptions(COMPANY, { conciergeModel: pair }, undefined, deps(false));
    assert.equal(opts, undefined);
  });

  it('lets an explicit thread choice win over the company pair', async () => {
    const explicit = { modelIdOverride: 'heavy/model', providerIdOverride: 'heavy-provider' };
    const opts = await resolveChatModelOptions(COMPANY, { conciergeModel: pair }, explicit, deps(true));
    assert.equal(opts, explicit, 'explicit override must pass through untouched');
  });

  it('passes a model-only ?modelId= override through untouched', async () => {
    const opts = await resolveChatModelOptions(
      COMPANY,
      { conciergeModel: pair },
      { modelIdOverride: 'overridden/model' },
      deps(true),
    );
    assert.deepEqual(opts, { modelIdOverride: 'overridden/model' });
  });

  it('keeps credentials out of the resolved options', async () => {
    const settings = {
      mcpCredentials: { 'buffer-mcp': 'SECRET-DO-NOT-LEAK' },
      tavilyApiKey: 'tvly-SECRET',
      conciergeModel: pair,
    };
    const opts = await resolveChatModelOptions(COMPANY, settings, undefined, deps(true));
    assert.ok(opts);
    assert.deepEqual(Object.keys(opts!), ['modelIdOverride', 'providerIdOverride']);
    assert.ok(!JSON.stringify(opts).includes('SECRET'));
  });
});

describe('CONCIERGE-MODEL-1 — hasExplicitChatModel', () => {
  it('treats blank overrides as implicit', () => {
    assert.equal(hasExplicitChatModel(undefined), false);
    assert.equal(hasExplicitChatModel({}), false);
    assert.equal(hasExplicitChatModel({ modelIdOverride: '  ' }), false);
    assert.equal(hasExplicitChatModel({ modelIdOverride: 'm' }), true);
    assert.equal(hasExplicitChatModel({ providerIdOverride: 'p' }), true);
  });
});

describe('CONCIERGE-PARAMS — params flow into the chat model options', () => {
  const pairWithParams = {
    providerId: 'prov-qwen',
    modelId: 'qwen/qwen3.6-35b-a3b',
    params: { maxContextTokens: 65_536, maxOutputTokens: 2_048 },
  };

  it('carries the pair params into the controller options', async () => {
    const opts = await resolveChatModelOptions(
      COMPANY,
      { conciergeModel: pairWithParams },
      undefined,
      deps(true),
    );
    assert.deepEqual(opts, {
      modelIdOverride: 'qwen/qwen3.6-35b-a3b',
      providerIdOverride: 'prov-qwen',
      params: { maxContextTokens: 65_536, maxOutputTokens: 2_048 },
    });
  });

  it('drops the pair when its provider is off, params and all', async () => {
    assert.equal(
      await resolveChatModelOptions(COMPANY, { conciergeModel: pairWithParams }, undefined, deps(false)),
      undefined,
    );
  });

  it('omits params from the options when the pair has none', async () => {
    const opts = await resolveChatModelOptions(COMPANY, { conciergeModel: pair }, undefined, deps(true));
    assert.deepEqual(Object.keys(opts!), ['modelIdOverride', 'providerIdOverride']);
  });
});

/**
 * CONCIERGE-PARAMS S1 (gate #195): the params pass-through at the two wiring sites the earlier
 * gates left untested — resolveChatModelOptions (pair params → controller options) and the
 * registry's createChatController options build (buildChatControllerOptions). Dropping params at
 * either site silently reverts the chat controller to the provider-default window.
 */
const PAIR_WITH_PARAMS = {
  providerId: 'prov-1',
  modelId: 'snappy-mini',
  params: { maxContextTokens: 65_536, maxOutputTokens: 2_048 },
};

describe('CONCIERGE-PARAMS S1 — params pass-through', () => {
  it('resolveChatModelOptions carries the pair params onto the controller options', async () => {
    const opts = await resolveChatModelOptions(COMPANY, { conciergeModel: PAIR_WITH_PARAMS }, undefined, deps(true));
    assert.deepEqual(opts, {
      modelIdOverride: 'snappy-mini',
      providerIdOverride: 'prov-1',
      params: { maxContextTokens: 65_536, maxOutputTokens: 2_048 },
    }, 'params must ride along (drop-params mutant → pair without params)');
  });

  it('an off provider still drops the params too (no partial pair)', async () => {
    const opts = await resolveChatModelOptions(COMPANY, { conciergeModel: PAIR_WITH_PARAMS }, undefined, deps(false));
    assert.equal(opts, undefined);
  });

  it('buildChatControllerOptions passes params, provider, effort and MCP ids to createChatController', () => {
    const o = buildChatControllerOptions(
      { allowedMcpServerIds: ['mcp-1'], settings: { conciergeModel: PAIR_WITH_PARAMS } },
      {
        modelIdOverride: 'snappy-mini',
        providerIdOverride: 'prov-1',
        reasoningLevelOverride: 'low' as never,
        params: PAIR_WITH_PARAMS.params,
      },
    );
    assert.deepEqual(o.params, { maxContextTokens: 65_536, maxOutputTokens: 2_048 }, 'the registry pass-through keeps params');
    assert.deepEqual(o.allowedMcpServerIds, ['mcp-1']);
    assert.deepEqual(o.companySettings?.conciergeModel, PAIR_WITH_PARAMS, 'company settings parsed for the controller');
    assert.equal(o.modelIdOverride, 'snappy-mini');
    assert.equal(o.providerIdOverride, 'prov-1');
    assert.equal(o.reasoningLevelOverride, 'low');
  });

  it('unset optionals are omitted (model-only override keeps the legacy shape)', () => {
    const o = buildChatControllerOptions(undefined, { modelIdOverride: 'legacy/model' });
    assert.deepEqual(o, { allowedMcpServerIds: [], companySettings: {}, modelIdOverride: 'legacy/model' });
  });
});
