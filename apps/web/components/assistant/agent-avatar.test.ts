/**
 * AGENT-AVATAR-UI: the avatar component renders the chosen blob shape + palette colour,
 * falls back to today's initials circle with no config, and carries only the ACTIVITY dot
 * (never unread). Rendered with react-dom/server (no DOM test library in the repo).
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

type Mod = typeof import('./agent-avatar');
let mod: Mod;
const avatar = () => mod.AgentAvatar;
const glyph = () => mod.AgentShapeGlyph;
const swatch = () => mod.AgentColorSwatch;

before(async () => {
  (globalThis as { React?: typeof React }).React = React;
  mod = await import('./agent-avatar');
});

const render = (props: Parameters<Mod['AgentAvatar']>[0]) =>
  renderToStaticMarkup(React.createElement(avatar(), props));

describe('AGENT-AVATAR-UI AgentAvatar', () => {
  it('default (no config): today’s initials circle, no SVG, no dot', () => {
    const out = render({ name: 'Ada Lovelace', config: null });
    assert.match(out, /data-avatar="default"/);
    assert.match(out, /bg-muted/);
    assert.match(out, /rounded-full/);
    assert.match(out, />AL</);
    assert.doesNotMatch(out, /<svg/);
    assert.doesNotMatch(out, /data-avatar-dot/);
  });

  it('custom config: shape path filled with the colour, initials on top', () => {
    const out = render({ name: 'Grace Hopper', config: { shape: 'blob-3', color: '#14b8a6' } });
    assert.match(out, /data-avatar="custom"/);
    assert.match(out, /data-avatar-shape="blob-3"/);
    assert.match(out, /data-avatar-color="#14b8a6"/);
    assert.match(out, /<path d="M36 4[^"]*" fill="#14b8a6">/);
    assert.match(out, />GH</);
  });

  it('activity dot: green working, yellow waiting, nothing idle; unread is never rendered here', () => {
    assert.match(render({ name: 'A B', config: null, activity: 'working' }), /bg-emerald-500"[^>]*data-avatar-dot="working"/);
    assert.match(render({ name: 'A B', config: { shape: 'circle', color: '#3b82f6' }, activity: 'waiting' }), /bg-amber-500"[^>]*data-avatar-dot="waiting"/);
    assert.doesNotMatch(render({ name: 'A B', config: null, activity: null }), /data-avatar-dot/);
    // No prop of this component can put an unread marker on the avatar.
    const src = render({ name: 'A B', config: null, activity: 'working' });
    assert.doesNotMatch(src, /unread|blue/i);
  });

  it('avatarInitials keeps the sidebar rule (two words, blank name → ?)', () => {
    assert.equal(mod.avatarInitials('Chief Exec'), 'CE');
    assert.equal(mod.avatarInitials('  '), '?');
    assert.equal(mod.avatarInitials('Solo'), 'S');
  });

  it('modal pickers: shape glyph and colour swatch are toggle buttons with pressed state', () => {
    const glyphHtml = renderToStaticMarkup(
      React.createElement(glyph(), { shape: 'blob-1', color: '#f43f5e', selected: true, onSelect: () => {}, label: 'Shape: blob-1' }),
    );
    assert.match(glyphHtml, /<button[^>]*data-shape="blob-1"/);
    assert.match(glyphHtml, /aria-pressed="true"/);
    assert.match(glyphHtml, /fill="#f43f5e">/);
    const swatchHtml = renderToStaticMarkup(
      React.createElement(swatch(), { id: 'violet', hex: '#8b5cf6', label: 'Violet', selected: false, onSelect: () => {} }),
    );
    assert.match(swatchHtml, /<button[^>]*data-color="violet"/);
    assert.match(swatchHtml, /aria-pressed="false"/);
    assert.match(swatchHtml, /background-color:#8b5cf6/);
  });
});
