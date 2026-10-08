/**
 * Tool-host allow-list fields (company and agent settings pages): any stored value renders, a
 * malformed one with a warning, so the board can save a fresh list over it.
 */
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

let ToolEgressAllowListFields: typeof import('./tool-egress-allow-list-fields').ToolEgressAllowListFields;

before(async () => {
  // The component is compiled with the classic JSX runtime under tsx.
  (globalThis as { React?: unknown }).React = React;
  ({ ToolEgressAllowListFields } = await import('./tool-egress-allow-list-fields'));
});

const render = (list: unknown, scope: 'company' | 'agent' = 'agent') =>
  renderToStaticMarkup(React.createElement(ToolEgressAllowListFields, { list, scope }));

/** Value of the checked mode radio ('off' | 'list'), or null when none is checked. */
const checkedMode = (html: string) => {
  const checked = (html.match(/<input[^>]*name="toolEgressMode"[^>]*>/g) ?? []).filter((tag) => /\bchecked=""/.test(tag));
  return checked.length === 1 ? (/value="(off|list)"/.exec(checked[0]!)?.[1] ?? null) : null;
};
const textarea = (html: string) => /<textarea[^>]*>([\s\S]*?)<\/textarea>/.exec(html)?.[1] ?? null;
const EMPTY_WARNING = /saved with an empty list/;
const UNREADABLE_LIST = /The saved list cannot be read, so no outbound host is allowed/;
const UNREADABLE_ENTRIES = /Some saved entries cannot be read/;

describe('ToolEgressAllowListFields', () => {
  it('stored value that is not a list: renders as an unreadable list with a warning, mode list, empty text', () => {
    for (const stored of ['search.example.com', { hosts: ['search.example.com'] }, 7, true]) {
      let html = '';
      assert.doesNotThrow(() => {
        html = render(stored);
      }, JSON.stringify(stored));
      assert.match(html, UNREADABLE_LIST, JSON.stringify(stored));
      assert.doesNotMatch(html, EMPTY_WARNING, JSON.stringify(stored));
      assert.equal(checkedMode(html), 'list', JSON.stringify(stored));
      assert.equal(textarea(html), '', JSON.stringify(stored));
      // The form is there to save a fresh list over it.
      assert.match(html, /name="toolEgressEntries"/);
    }
  });

  it('list with an unreadable or non-string entry: entries warning, readable entries kept', () => {
    const html = render(['ok.example', 7, 'https://bad.example/x']);
    assert.match(html, UNREADABLE_ENTRIES);
    assert.equal(checkedMode(html), 'list');
    assert.equal(textarea(html), 'ok.example\nhttps://bad.example/x');
  });

  it('empty list: empty-list warning only', () => {
    const html = render([]);
    assert.match(html, EMPTY_WARNING);
    assert.doesNotMatch(html, UNREADABLE_LIST);
    assert.doesNotMatch(html, UNREADABLE_ENTRIES);
    assert.equal(checkedMode(html), 'list');
  });

  it('unset (undefined or null): off, no warning', () => {
    for (const stored of [undefined, null]) {
      const html = render(stored, 'company');
      assert.equal(checkedMode(html), 'off');
      assert.doesNotMatch(html, /role="status"/);
      assert.equal(textarea(html), '');
    }
  });

  it('valid list: entries one per line, no warning', () => {
    const html = render(['search.example.com', '*.example.org:443']);
    assert.equal(checkedMode(html), 'list');
    assert.equal(textarea(html), 'search.example.com\n*.example.org:443');
    assert.doesNotMatch(html, /role="status"/);
  });

  it('help says it is matched by host name and is not an internal-network or DNS guard', () => {
    const html = render(undefined);
    assert.match(html, /Matched by host name only, without DNS lookups/);
    assert.match(html, /not an internal-network or DNS guard/);
    assert.match(html, /cannot cover a whole public suffix/);
  });
});
