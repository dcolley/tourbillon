/**
 * CHAT-2: table export for the assistant message renderer. Pure functions over the cell text a
 * rendered GFM table already shows, so a copied table carries nothing the message did not show.
 */

/** Minimal hast shape (react-markdown passes each element's hast node as `node`). */
export interface HastLike {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastLike[];
}

export type TableRows = string[][];

/** Visible text of a hast subtree. */
export function hastText(node: HastLike | undefined): string {
  if (!node) return '';
  if (node.type === 'text') return node.value ?? '';
  if (node.type === 'element' && node.tagName === 'br') return ' ';
  return (node.children ?? []).map(hastText).join('');
}

/** Cell text per row (header row first) of a hast `<table>`; short rows are padded to the widest. */
export function tableRowsFromHast(table: HastLike | undefined): TableRows {
  const rows: TableRows = [];
  const visit = (n: HastLike) => {
    if (n.type !== 'element' && n.type !== 'root') return;
    if (n.tagName === 'tr') {
      rows.push(
        (n.children ?? [])
          .filter((c) => c.type === 'element' && (c.tagName === 'th' || c.tagName === 'td'))
          .map((c) => hastText(c).replace(/\s+/g, ' ').trim()),
      );
      return;
    }
    (n.children ?? []).forEach(visit);
  };
  if (table) visit(table);
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  return rows.map((r) => (r.length < width ? [...r, ...Array<string>(width - r.length).fill('')] : r));
}

const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^[+-]?(\d[\d,]*(\.\d+)?|\.\d+)(e[+-]?\d+)?%?$/i;

/**
 * Cells that a spreadsheet would read as a formula (leading = + - @) get a leading apostrophe so
 * they paste as text. Plain numbers such as -5 or +3.2% are left as they are.
 */
export function guardSpreadsheetCell(cell: string): string {
  return FORMULA_START.test(cell) && !PLAIN_NUMBER.test(cell) ? `'${cell}` : cell;
}

function csvCell(cell: string): string {
  const v = guardSpreadsheetCell(cell);
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** RFC 4180 CSV: comma separated, CRLF rows, fields with comma / quote / newline quoted. */
export function tableToCsv(rows: TableRows): string {
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}

/** Tab separated, LF rows; tabs and newlines inside a cell become a space. */
export function tableToTsv(rows: TableRows): string {
  return rows.map((r) => r.map((c) => guardSpreadsheetCell(c.replace(/[\t\r\n]+/g, ' '))).join('\t')).join('\n');
}
