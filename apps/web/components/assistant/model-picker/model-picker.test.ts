/**
 * CHAT-5: composer model picker — controller (load, provider → models, save on model / effort,
 * "Agent default" reset, refusals) and the stateless view (server render plus the element tree;
 * no DOM library in this repo).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ModelPickerView } from './model-picker';
import { createModelPickerController, type ModelPickerSnapshot } from './model-picker-controller';
import type { ThreadModelState } from '@/lib/assistant/thread-model';

(globalThis as { React?: typeof React }).React = React;

type El = ReactElement<Record<string, any>>;
function all(node: ReactNode, out: El[] = []): El[] {
  if (Array.isArray(node)) node.forEach((n) => all(n, out));
  else if (isValidElement(node)) {
    out.push(node as El);
    all((node as El).props.children, out);
  }
  return out;
}
const selects = (tree: ReactNode) => all(tree).filter((e) => e.type === 'select');
const optionValues = (el: El) => all(el.props.children).filter((e) => e.type === 'option').map((o) => o.props.value);

const BASE_STATE: ThreadModelState = {
  choice: null,
  choiceAvailable: true,
  agentDefault: { providerId: 'p-cloud', providerName: 'Cloud', modelId: 'agent/model' },
  providers: [
    { id: 'p-cloud', name: 'Cloud', type: 'openai' },
    { id: 'p-local', name: 'Local', type: 'lmstudio' },
  ],
};

const MODELS: Record<string, unknown> = {
  'p-cloud': { models: [{ id: 'openai/gpt-5' }, { id: 'llama-3.1-8b' }] },
  'p-local': { models: [{ id: 'local-r', reasoningCapabilities: { supported: true, allowedLevels: ['none', 'high'] } }] },
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function harness(initial: ThreadModelState = BASE_STATE, opts: { refuseSave?: boolean } = {}) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  let state = initial;
  const fetch = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, ...(body ? { body } : {}) });
    if (url.startsWith('/api/models?providerId=')) {
      const id = decodeURIComponent(url.split('=')[1]);
      return MODELS[id] ? json(MODELS[id]) : json({ error: 'Provider is switched off', code: 'provider_disabled_for_company' }, 409);
    }
    if (method === 'GET') return json({ state });
    if (opts.refuseSave) return json({ error: 'That provider is not available to this company', code: 'provider_disabled_for_company' }, 409);
    state = { ...state, choice: method === 'DELETE' ? null : (body as ThreadModelState['choice']) };
    return json({ state });
  };
  const c = createModelPickerController({ agentId: 'agent a', threadId: 't/1', fetch });
  return { c, calls };
}

const MODEL_URL = '/api/assistant/agents/agent%20a/threads/t%2F1/model';

describe('CHAT-5 model picker controller', () => {
  it('loads the thread state; agent default selected, no models requested', async () => {
    const { c, calls } = harness();
    await c.load();
    const s = c.getSnapshot();
    assert.equal(s.status, 'ready');
    assert.equal(s.providerId, '');
    assert.deepEqual(calls, [{ url: MODEL_URL, method: 'GET' }]);
  });

  it("provider → its models; model → saved on the thread; effort only for models that support it", async () => {
    const { c, calls } = harness();
    await c.load();
    await c.selectProvider('p-cloud');
    assert.deepEqual(c.getSnapshot().models?.map((m) => m.id), ['openai/gpt-5', 'llama-3.1-8b']);
    assert.equal(calls.filter((x) => x.method !== 'GET').length, 0, 'nothing saved before a model is picked');

    await c.selectModel('llama-3.1-8b');
    assert.deepEqual(c.getSnapshot().effortLevels, []);
    assert.deepEqual(calls.at(-1), { url: MODEL_URL, method: 'PUT', body: { providerId: 'p-cloud', modelId: 'llama-3.1-8b' } });

    await c.selectModel('openai/gpt-5');
    assert.deepEqual(c.getSnapshot().effortLevels, ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
    await c.selectEffort('high');
    assert.deepEqual(calls.at(-1)?.body, { providerId: 'p-cloud', modelId: 'openai/gpt-5', reasoningLevel: 'high' });
    assert.equal(c.getSnapshot().reasoningLevel, 'high');
  });

  it("uses the provider's own effort levels (LM Studio) and drops a level the new model lacks", async () => {
    const { c, calls } = harness({
      ...BASE_STATE,
      choice: { providerId: 'p-cloud', modelId: 'openai/gpt-5', reasoningLevel: 'xhigh' },
    });
    await c.load();
    assert.equal(c.getSnapshot().reasoningLevel, 'xhigh');
    await c.selectProvider('p-local');
    await c.selectModel('local-r');
    assert.deepEqual(c.getSnapshot().effortLevels, ['none', 'high']);
    assert.deepEqual(calls.at(-1)?.body, { providerId: 'p-local', modelId: 'local-r' });
  });

  it('only providers the server listed can be chosen; "Agent default" clears the choice', async () => {
    const { c, calls } = harness({ ...BASE_STATE, choice: { providerId: 'p-cloud', modelId: 'openai/gpt-5' } });
    await c.load();
    await c.selectProvider('p-disabled');
    assert.equal(c.getSnapshot().providerId, 'p-cloud');
    assert.ok(!calls.some((x) => x.url.includes('p-disabled')));
    await c.selectProvider('');
    assert.deepEqual(calls.at(-1), { url: MODEL_URL, method: 'DELETE' });
    assert.equal(c.getSnapshot().providerId, '');
    assert.equal(c.getSnapshot().state?.choice, null);
  });

  it('a stored choice whose provider was switched off shows as unavailable (agent default selected)', async () => {
    const { c } = harness({ ...BASE_STATE, choice: { providerId: 'p-off', modelId: 'm' }, choiceAvailable: false });
    await c.load();
    const s = c.getSnapshot();
    assert.equal(s.providerId, '');
    assert.match(s.error ?? '', /no longer available/);
  });

  it('a refused save shows the server message', async () => {
    const { c } = harness(BASE_STATE, { refuseSave: true });
    await c.load();
    await c.selectProvider('p-cloud');
    await c.selectModel('openai/gpt-5');
    assert.equal(c.getSnapshot().error, 'That provider is not available to this company');
    assert.equal(c.getSnapshot().saving, false);
  });
});

describe('CHAT-5 model picker view', () => {
  const ready = (patch: Partial<ModelPickerSnapshot> = {}): ModelPickerSnapshot => ({
    status: 'ready',
    state: BASE_STATE,
    providerId: '',
    modelId: '',
    reasoningLevel: '',
    models: null,
    modelsLoading: false,
    effortLevels: [],
    saving: false,
    error: null,
    ...patch,
  });
  const noop = () => {};
  const view = (snapshot: ModelPickerSnapshot, extra: { disabled?: boolean; onProvider?: (v: string) => void; onModel?: (v: string) => void; onEffort?: (v: string) => void } = {}) =>
    ModelPickerView({
      snapshot,
      disabled: extra.disabled,
      onProvider: extra.onProvider ?? noop,
      onModel: extra.onModel ?? noop,
      onEffort: (extra.onEffort ?? noop) as never,
    });

  it('agent default: provider list = default + enabled providers; no model or effort select', () => {
    const tree = view(ready());
    const [provider, ...rest] = selects(tree);
    assert.equal(rest.length, 0);
    assert.equal(provider.props['aria-label'], 'Provider');
    assert.deepEqual(optionValues(provider), ['', 'p-cloud', 'p-local']);
    const html = renderToStaticMarkup(tree);
    assert.match(html, /Agent default \(Cloud · agent\/model\)/);
    assert.match(html, /data-thread-model="agent"/);
  });

  it('a thread choice shows model and, when supported, effort; handlers get the values', () => {
    const got: string[] = [];
    const tree = view(
      ready({
        providerId: 'p-cloud',
        modelId: 'openai/gpt-5',
        reasoningLevel: 'high',
        models: [{ id: 'openai/gpt-5' }, { id: 'llama-3.1-8b' }],
        effortLevels: ['low', 'high'],
      }),
      { onProvider: (v) => got.push(`p:${v}`), onModel: (v) => got.push(`m:${v}`), onEffort: (v) => got.push(`e:${v}`) },
    );
    const [provider, model, effort] = selects(tree);
    assert.deepEqual(optionValues(model), ['', 'openai/gpt-5', 'llama-3.1-8b']);
    assert.deepEqual(optionValues(effort), ['', 'low', 'high']);
    assert.equal(effort.props.value, 'high');
    provider.props.onChange({ target: { value: '' } });
    model.props.onChange({ target: { value: 'llama-3.1-8b' } });
    effort.props.onChange({ target: { value: 'low' } });
    assert.deepEqual(got, ['p:', 'm:llama-3.1-8b', 'e:low']);
    assert.match(renderToStaticMarkup(tree), /Extra high|High/);
  });

  it('effort hidden for models without it; current model kept listed', () => {
    const tree = view(ready({ providerId: 'p-cloud', modelId: 'gone-model', models: [{ id: 'llama-3.1-8b' }] }));
    const s = selects(tree);
    assert.equal(s.length, 2);
    assert.deepEqual(optionValues(s[1]), ['', 'gone-model', 'llama-3.1-8b']);
  });

  it('disabled while a run is open or saving', () => {
    for (const tree of [view(ready({ providerId: 'p-cloud', modelId: 'm', effortLevels: ['high'] }), { disabled: true }), view(ready({ saving: true }))]) {
      for (const s of selects(tree)) assert.equal(s.props.disabled, true);
    }
  });

  it('loading and load error states', () => {
    assert.match(renderToStaticMarkup(view({ ...ready(), status: 'loading', state: null })), /Loading models/);
    assert.match(
      renderToStaticMarkup(view({ ...ready(), status: 'error', state: null, error: 'Agent not found' })),
      /role="alert"[^>]*>Agent not found/,
    );
  });
});
