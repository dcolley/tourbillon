/**
 * CHAT-2: assistant message renderer. Markup via react-dom/server; copy wiring through the
 * exported stateless views and element overrides (no DOM test library in the repo).
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { HastLike } from '../../lib/assistant/message-table';

type M = typeof import('./message-markdown');
let mod: M;
let Button: unknown;

const html = (text: string) => renderToStaticMarkup(React.createElement(mod.ChatMarkdown, { text }));
/** An opening tag that carries an inline event handler attribute. */
const HANDLER_ATTR = /<[a-z][^>]*\son[a-z]+\s*=/i;

const text = (value: string): HastLike => ({ type: 'text', value });
const el = (tagName: string, children: HastLike[] = [], properties: Record<string, unknown> = {}): HastLike => ({
  type: 'element',
  tagName,
  properties,
  children,
});

/** Elements of `type` in a tree, expanding plain function components except `type` itself and Button. */
function find(node: React.ReactNode, type: unknown, out: React.ReactElement[] = []): React.ReactElement[] {
  if (node == null || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    node.forEach((n) => find(n, type, out));
    return out;
  }
  if (!React.isValidElement(node)) return out;
  if (node.type === type) {
    out.push(node);
    return out;
  }
  const props = node.props as { children?: React.ReactNode };
  if (typeof node.type === 'function' && node.type !== Button) {
    find((node.type as (p: unknown) => React.ReactNode)(props), type, out);
  } else find(props.children, type, out);
  return out;
}

describe('CHAT-2 ChatMarkdown', () => {
  before(async () => {
    (globalThis as { React?: unknown }).React = React;
    mod = await import('./message-markdown');
    ({ Button } = await import('@/components/ui/button'));
  });

  it('renders markdown: headings, emphasis, lists, inline code, links', () => {
    const h = html('# Title\n\nSome **bold** and `x()`.\n\n- one\n- two\n\n[docs](https://example.com/docs)');
    assert.match(h, /<h1[^>]*>Title<\/h1>/);
    assert.match(h, /<strong>bold<\/strong>/);
    assert.match(h, /<code[^>]*>x\(\)<\/code>/);
    assert.match(h, /<li>one<\/li>/);
    assert.match(h, /<a href="https:\/\/example.com\/docs" target="_blank" rel="noopener noreferrer nofollow"/);
  });

  it('raw HTML is shown as text: script and img onerror never become elements', () => {
    const h = html(
      'Hi <script>alert(1)</script>\n\n<img src="x" onerror="alert(1)">\n\n<div onclick="steal()">d</div>\n\n<iframe src="https://example.com"></iframe>',
    );
    assert.doesNotMatch(h, /<script/i);
    assert.doesNotMatch(h, /<img/i);
    assert.doesNotMatch(h, /<iframe/i);
    assert.doesNotMatch(h, /<div onclick/i);
    assert.doesNotMatch(h, HANDLER_ATTR);
    // The text is still there, escaped.
    assert.match(h, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  });

  it('unsafe link targets are dropped; only http(s), mailto and relative links are kept', () => {
    const h = html('[a](javascript:alert(1)) [b](data:text/html;base64,PHNjcmlwdD4=) [c](vbscript:x) [d](mailto:a@example.com) [e](/issue/1)');
    assert.doesNotMatch(h, /javascript:/i);
    assert.doesNotMatch(h, /data:text/i);
    assert.doesNotMatch(h, /vbscript:/i);
    assert.match(h, /href="mailto:a@example.com"/);
    assert.match(h, /href="\/issue\/1"/);
    assert.equal(mod.chatUrlTransform('ftp://example.com/x'), '');
    assert.equal(mod.chatUrlTransform('https://example.com/x'), 'https://example.com/x');
  });

  it('images are not loaded: shown as a link', () => {
    const h = html('![chart](https://example.com/a.png) ![bad](javascript:alert(1))');
    assert.doesNotMatch(h, /<img/i);
    assert.match(h, /<a href="https:\/\/example.com\/a.png"[^>]*data-image-link[^>]*>Image: chart<\/a>/);
    assert.doesNotMatch(h, /javascript:/i);
  });

  it('fenced code: language label, copy control, code as text', () => {
    const h = html('```ts\nconst a = "<b>";\n```');
    assert.match(h, /data-code-block="true" data-language="ts"/);
    assert.match(h, /<span class="font-mono">ts<\/span>/);
    assert.match(h, /aria-label="Copy code"[^>]*>Copy</);
    assert.match(h, /<code class="font-mono language-ts">const a = &quot;&lt;b&gt;&quot;;<\/code>/);
    // No language: labelled as text; an odd hint is ignored.
    assert.match(html('```\nplain\n```'), /data-language=""[\s\S]*>text</);
    assert.equal(mod.codeLanguage(['language-"><x']), undefined);
    assert.equal(mod.codeLanguage(['language-c++']), 'c++');
  });

  it('code copy wiring: the pre override passes the exact code; Copy writes it to the clipboard', async () => {
    const pre = el('pre', [el('code', [text('line 1\nline 2\n')], { className: ['language-python'] })]);
    const block = (mod.chatMarkdownComponents.pre as (p: { node: HastLike }) => React.ReactElement)({ node: pre });
    assert.equal(block.type, mod.CodeBlock);
    assert.deepEqual(block.props, { language: 'python', code: 'line 1\nline 2' });

    const written: string[] = [];
    const done: boolean[] = [];
    const handler = mod.makeCopyHandler('line 1\nline 2', (ok) => done.push(ok), { writeText: async (t) => void written.push(t) });
    assert.equal(await handler(), true);
    assert.deepEqual(written, ['line 1\nline 2']);
    assert.deepEqual(done, [true]);
    assert.equal(await mod.makeCopyHandler('x', (ok) => done.push(ok), null)(), false);
    assert.deepEqual(done, [true, false]);

    let copies = 0;
    const view = mod.CodeBlockView({ language: 'python', code: 'x', copied: false, onCopy: () => copies++ });
    const [button] = find(view, Button);
    (button.props as { onClick: () => void }).onClick();
    assert.equal(copies, 1);
    assert.match(renderToStaticMarkup(React.createElement(mod.CodeBlockView, { code: 'x', copied: true, onCopy: () => {} })), />Copied</);
  });

  it('GFM table: rendered with Copy CSV / Copy TSV; copy text is the shown cells', () => {
    const md = '| Item | Price |\n|---|---|\n| Tea, green | 3 |\n| =cmd | -1 |';
    const h = html(md);
    assert.match(h, /data-table-block="true" data-rows="3" data-columns="2"/);
    assert.match(h, /data-copy="csv"[^>]*>Copy CSV</);
    assert.match(h, /data-copy="tsv"[^>]*>Copy TSV</);
    assert.match(h, /<th[^>]*>Item<\/th>/);
    assert.match(h, /<td[^>]*>Tea, green<\/td>/);

    const table = el('table', [
      el('thead', [el('tr', [el('th', [text('Item')]), el('th', [text('Price')])])]),
      el('tbody', [el('tr', [el('td', [text('Tea, green')]), el('td', [text('3')])])]),
    ]);
    const block = (mod.chatMarkdownComponents.table as (p: { node: HastLike }) => React.ReactElement)({ node: table });
    assert.equal(block.type, mod.TableBlock);
    const rows = (block.props as { rows: string[][] }).rows;
    assert.deepEqual(rows, [['Item', 'Price'], ['Tea, green', '3']]);
    assert.equal(mod.tableCopyText(rows, 'csv'), 'Item,Price\r\n"Tea, green",3');
    assert.equal(mod.tableCopyText(rows, 'tsv'), 'Item\tPrice\nTea, green\t3');

    const formats: string[] = [];
    const view = mod.TableBlockView({ rows, copied: null, onCopy: (f) => formats.push(f) });
    for (const b of find(view, Button)) (b.props as { onClick: () => void }).onClick();
    assert.deepEqual(formats, ['csv', 'tsv']);
  });
});
