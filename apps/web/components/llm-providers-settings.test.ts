/** PRV-1: per-company provider switch in Settings → Providers. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

(globalThis as { React?: typeof React }).React = React;

describe('CompanyProviderToggle', () => {
  it('renders an on switch for the company', async () => {
    const { CompanyProviderToggle } = await import('./llm-providers-settings');
    const html = renderToStaticMarkup(
      createElement(CompanyProviderToggle, {
        providerName: 'Local studio',
        companyName: 'Alpha',
        enabled: true,
        onChange: () => undefined,
      }),
    );
    assert.match(html, /role="switch"/);
    assert.match(html, /checked=""/);
    assert.match(html, /aria-label="Use Local studio in Alpha"/);
    assert.match(html, /On for Alpha/);
  });

  it('renders off, and disabled while saving', async () => {
    const { CompanyProviderToggle } = await import('./llm-providers-settings');
    const off = renderToStaticMarkup(
      createElement(CompanyProviderToggle, {
        providerName: 'Cloud',
        companyName: 'Alpha',
        enabled: false,
        onChange: () => undefined,
      }),
    );
    assert.doesNotMatch(off, /checked=""/);
    assert.match(off, /Off for Alpha/);
    const saving = renderToStaticMarkup(
      createElement(CompanyProviderToggle, {
        providerName: 'Cloud',
        companyName: 'Alpha',
        enabled: false,
        pending: true,
        onChange: () => undefined,
      }),
    );
    assert.match(saving, /disabled=""/);
    assert.match(saving, /Saving…/);
  });
});
