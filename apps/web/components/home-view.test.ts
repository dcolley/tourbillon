/** UI-1: `/` for signed-out visitors (landing page) and signed-in users (redirect to stored view). */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React, { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

(globalThis as { React?: typeof React }).React = React;

const g = globalThis as { window?: unknown };

describe('HomeView', () => {
  let savedWindow: unknown;
  beforeEach(() => {
    savedWindow = g.window;
  });
  afterEach(() => {
    if (savedWindow === undefined) delete g.window;
    else g.window = savedWindow;
  });

  it('signed out → the public landing page, not the redirect', async () => {
    const { HomeView } = await import('./home-view');
    const { HomeLanding } = await import('./home-landing');
    const el = HomeView({ signedIn: false }) as ReactElement;
    assert.equal(el.type, HomeLanding);
    const html = renderToStaticMarkup(createElement(HomeLanding));
    assert.match(html, /<h1[^>]*>Tourbillon<\/h1>/);
    assert.match(html, /Open-source AI agent orchestration/);
    assert.match(html, /href="\/dashboard"[^>]*>Open Dashboard</);
    assert.match(html, /href="https:\/\/github.com\/dcolley\/tourbillon"/);
    assert.doesNotMatch(html, /Opening Tourbillon/);
  });

  it('signed in → the redirect to the stored view', async () => {
    const { HomeView } = await import('./home-view');
    const { HomeRedirect, HomeRedirectView } = await import('./home-redirect');
    const el = HomeView({ signedIn: true }) as ReactElement;
    assert.equal(el.type, HomeRedirect);
    const html = renderToStaticMarkup(createElement(HomeRedirectView));
    assert.match(html, /Opening Tourbillon…/);
    assert.match(html, /href="\/assistant"/);
    assert.match(html, /href="\/dashboard"/);
    assert.doesNotMatch(html, /Open Dashboard/);
  });

  it('signed-in redirect target: stored view, default /assistant', async () => {
    const { homeRedirectPath, VIEW_PREFERENCE_STORAGE_KEY } = await import('../lib/view-preference');
    const store = new Map<string, string>();
    g.window = {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
    };
    assert.equal(homeRedirectPath(), '/assistant');
    store.set(VIEW_PREFERENCE_STORAGE_KEY, 'control');
    assert.equal(homeRedirectPath(), '/dashboard');
    store.set(VIEW_PREFERENCE_STORAGE_KEY, 'assistant');
    assert.equal(homeRedirectPath(), '/assistant');
  });
});
