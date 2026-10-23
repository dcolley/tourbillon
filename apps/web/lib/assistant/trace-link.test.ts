/**
 * OBS-1: trace link helpers and the footer link component (hidden when Phoenix is not configured).
 * The repo has no DOM test library, so the component is checked with react-dom/server markup.
 */
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildTraceUrl, isTraceId, traceFromAguiEvent, traceIdFromMessage } from './trace-link';

type Comp = typeof import('@/components/assistant/trace-link');
let TraceLink: Comp['TraceLink'];
let TraceLinkProvider: Comp['TraceLinkProvider'];

const TRACE = '0af7651916cd43dd8448eb211c80319c';
const BASE = 'https://phoenix.example.com';

describe('OBS-1 buildTraceUrl', () => {
  it('builds the Phoenix trace redirect URL', () => {
    assert.equal(buildTraceUrl(BASE, TRACE), `${BASE}/redirects/traces/${TRACE}`);
    assert.equal(buildTraceUrl(`${BASE}/`, TRACE.toUpperCase()), `${BASE}/redirects/traces/${TRACE}`);
    assert.equal(buildTraceUrl('http://localhost:6006/phoenix/', TRACE), `http://localhost:6006/phoenix/redirects/traces/${TRACE}`);
  });

  it('hidden (undefined) when the base URL is unset or unsafe', () => {
    assert.equal(buildTraceUrl(undefined, TRACE), undefined);
    assert.equal(buildTraceUrl(null, TRACE), undefined);
    assert.equal(buildTraceUrl('', TRACE), undefined);
    assert.equal(buildTraceUrl('javascript:alert(1)', TRACE), undefined);
    assert.equal(buildTraceUrl('https://u:p@phoenix.example.com', TRACE), undefined);
    assert.equal(buildTraceUrl('not a url', TRACE), undefined);
  });

  it('hidden when the trace id is missing or not hex', () => {
    assert.equal(buildTraceUrl(BASE, undefined), undefined);
    assert.equal(buildTraceUrl(BASE, ''), undefined);
    assert.equal(buildTraceUrl(BASE, '../../admin'), undefined);
    assert.equal(buildTraceUrl(BASE, 'a'.repeat(33)), undefined);
    assert.equal(isTraceId(TRACE), true);
  });
});

describe('OBS-1 trace id sources', () => {
  it('reads content.metadata.traceId from a hydrated message', () => {
    assert.equal(traceIdFromMessage({ content: { format: 2, parts: [], metadata: { traceId: TRACE } } }), TRACE);
    assert.equal(traceIdFromMessage({ content: { metadata: { traceId: 'nope!' } } }), undefined);
    assert.equal(traceIdFromMessage({ content: 'plain' }), undefined);
    assert.equal(traceIdFromMessage(null), undefined);
  });

  it('reads the trace from the tourbillon.trace CUSTOM event and RUN_FINISHED result', () => {
    assert.deepEqual(
      traceFromAguiEvent({ type: 'CUSTOM', name: 'tourbillon.trace', value: { traceId: TRACE, traceUrl: `${BASE}/x` } }),
      { traceId: TRACE, traceUrl: `${BASE}/x` },
    );
    assert.deepEqual(traceFromAguiEvent({ type: 'RUN_FINISHED', result: { reason: 'complete', traceId: TRACE } }), {
      traceId: TRACE,
    });
    assert.equal(traceFromAguiEvent({ type: 'CUSTOM', name: 'other', value: { traceId: TRACE } }), undefined);
    assert.equal(traceFromAguiEvent({ type: 'RUN_FINISHED', result: { reason: 'complete' } }), undefined);
    assert.equal(traceFromAguiEvent({ type: 'TEXT_MESSAGE_START' }), undefined);
  });
});

describe('OBS-1 TraceLink component', () => {
  before(async () => {
    (globalThis as { React?: unknown }).React = React;
    ({ TraceLink, TraceLinkProvider } = await import('@/components/assistant/trace-link'));
  });
  const render = (el: React.ReactElement) => renderToStaticMarkup(el);

  it('renders nothing when Phoenix is not configured (no provider, null or empty base URL)', () => {
    assert.equal(render(React.createElement(TraceLink, { traceId: TRACE })), '');
    assert.equal(
      render(React.createElement(TraceLinkProvider, { baseUrl: null }, React.createElement(TraceLink, { traceId: TRACE }))),
      '',
    );
    assert.equal(render(React.createElement(TraceLink, { traceId: TRACE, baseUrl: '' })), '');
  });

  it('renders nothing when the message has no trace id', () => {
    assert.equal(
      render(React.createElement(TraceLinkProvider, { baseUrl: BASE }, React.createElement(TraceLink, { traceId: undefined }))),
      '',
    );
  });

  it('renders a "Trace" link from the provider base URL, opening in a new tab', () => {
    const html = render(
      React.createElement(TraceLinkProvider, { baseUrl: BASE }, React.createElement(TraceLink, { traceId: TRACE })),
    );
    assert.match(html, /data-trace-link=""/);
    assert.ok(html.includes(`href="${BASE}/redirects/traces/${TRACE}"`), html);
    assert.match(html, /target="_blank"/);
    assert.match(html, /rel="noopener noreferrer"/);
    assert.match(html, />Trace<\/a>/);
  });

  it('a baseUrl prop overrides the provider (null hides it)', () => {
    const inner = (baseUrl: string | null) =>
      render(React.createElement(TraceLinkProvider, { baseUrl: BASE }, React.createElement(TraceLink, { traceId: TRACE, baseUrl })));
    assert.ok(inner('http://localhost:6006').includes(`href="http://localhost:6006/redirects/traces/${TRACE}"`));
    assert.equal(inner(null), '');
  });
});
