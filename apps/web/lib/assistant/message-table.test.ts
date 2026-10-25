/** CHAT-2: table export shape (CSV / TSV) and cell extraction from the rendered table. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { guardSpreadsheetCell, hastText, tableRowsFromHast, tableToCsv, tableToTsv, type HastLike } from './message-table';

const text = (value: string): HastLike => ({ type: 'text', value });
const el = (tagName: string, children: HastLike[] = []): HastLike => ({ type: 'element', tagName, properties: {}, children });
const row = (tag: 'th' | 'td', cells: Array<string | HastLike[]>) =>
  el('tr', cells.map((c) => el(tag, typeof c === 'string' ? [text(c)] : c)));

describe('CHAT-2 table export', () => {
  it('reads header and body rows from a hast table, joining inline formatting and padding short rows', () => {
    const table = el('table', [
      el('thead', [row('th', ['Name', 'Qty', 'Note'])]),
      el('tbody', [
        row('td', [[el('strong', [text('Apples')])], '3', [text('red '), el('code', [text('x')])]]),
        row('td', ['Pears']),
      ]),
    ]);
    assert.deepEqual(tableRowsFromHast(table), [
      ['Name', 'Qty', 'Note'],
      ['Apples', '3', 'red x'],
      ['Pears', '', ''],
    ]);
    assert.equal(hastText(el('p', [text('a'), el('br'), text('b')])), 'a b');
    assert.deepEqual(tableRowsFromHast(undefined), []);
  });

  it('CSV: comma separated, CRLF rows, quoting for comma, quote and newline', () => {
    const csv = tableToCsv([
      ['a', 'b', 'c'],
      ['1', 'x,y', 'say "hi"'],
      ['line\nbreak', '', 'plain'],
    ]);
    assert.equal(csv, 'a,b,c\r\n1,"x,y","say ""hi"""\r\n"line\nbreak",,plain');
    assert.equal(csv.split('\r\n')[0].split(',').length, 3);
  });

  it('TSV: tab separated, LF rows, tabs and newlines inside cells become spaces', () => {
    assert.equal(tableToTsv([['a', 'b'], ['x\ty', 'p\nq']]), 'a\tb\nx y\tp q');
  });

  it('formula-like cells are prefixed so spreadsheets read them as text; plain numbers are kept', () => {
    assert.equal(guardSpreadsheetCell('=SUM(A1:A2)'), "'=SUM(A1:A2)");
    assert.equal(guardSpreadsheetCell('@cmd'), "'@cmd");
    assert.equal(guardSpreadsheetCell('+x'), "'+x");
    assert.equal(guardSpreadsheetCell('-5'), '-5');
    assert.equal(guardSpreadsheetCell('+3.2%'), '+3.2%');
    assert.equal(guardSpreadsheetCell('1,234.5'), '1,234.5');
    assert.equal(tableToCsv([['=1+1', '-2']]), "'=1+1,-2");
    assert.equal(tableToTsv([['=1+1', '-2']]), "'=1+1\t-2");
  });
});
