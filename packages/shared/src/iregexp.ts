/**
 * APR-2: RFC 9485 I-Regexp (interoperable regular expressions) for `hitl/request/v0`
 * `bounds.pattern` on text answers.
 *
 * - `compileIRegexp` refuses anything outside the RFC 9485 grammar (no anchors, lookaround,
 *   backreferences, lazy quantifiers, `(?` groups or shorthand classes like `\d`).
 * - Matching is a Thompson NFA simulation: time is linear in the input length times the pattern
 *   size, so a hostile pattern cannot cause catastrophic backtracking (no host regex engine is
 *   used for matching).
 * - I-Regexp matches the whole string (implicit anchoring); `.` matches any character except
 *   `\n` and `\r`.
 */

export const IREGEXP_MAX_LENGTH = 256;
/** Upper bound on NFA states after expanding `{n,m}` repetitions. */
export const IREGEXP_MAX_STATES = 20_000;

type CharTest = (cp: number) => boolean;
type Node =
  | { t: 'char'; test: CharTest }
  | { t: 'seq'; items: Node[] }
  | { t: 'alt'; alts: Node[] }
  | { t: 'rep'; node: Node; min: number; max: number };

export type IRegexpResult =
  | { ok: true; pattern: string; test: (input: string) => boolean }
  | { ok: false; error: string; index: number };

class IRegexpSyntaxError extends Error {
  constructor(
    message: string,
    readonly index: number,
  ) {
    super(message);
  }
}

const CATEGORY = /^(L[lmotu]?|M[cen]?|N[dlo]?|P[cdefios]?|Z[lps]?|S[ckmo]?|C[cfno]?)$/;
const categoryCache = new Map<string, RegExp>();
function categoryTest(prop: string, negate: boolean): CharTest {
  let re = categoryCache.get(prop);
  if (!re) {
    re = new RegExp(`^\\p{${prop}}$`, 'u');
    categoryCache.set(prop, re);
  }
  const r = re;
  return (cp) => r.test(String.fromCodePoint(cp)) !== negate;
}

/** Characters that NormalChar excludes: ( ) * + . ? [ \ ] { | } */
const META = new Set(['(', ')', '*', '+', '.', '?', '[', '\\', ']', '{', '|', '}']);
/** SingleCharEsc: \ followed by one of these (n, r, t map to control characters). */
const SINGLE_ESC = new Set(['(', ')', '*', '+', '-', '.', '?', '[', '\\', ']', '^', 'n', 'r', 't', '{', '|', '}']);

function escValue(c: string): number {
  if (c === 'n') return 0x0a;
  if (c === 'r') return 0x0d;
  if (c === 't') return 0x09;
  return c.codePointAt(0)!;
}

class Parser {
  private i = 0;
  private readonly cps: string[];
  constructor(src: string) {
    this.cps = Array.from(src);
  }
  private peek(): string | undefined {
    return this.cps[this.i];
  }
  private fail(msg: string): never {
    throw new IRegexpSyntaxError(msg, this.i);
  }
  parse(): Node {
    const node = this.regexp();
    if (this.i < this.cps.length) this.fail(`unexpected "${this.peek()}"`);
    return node;
  }
  private regexp(): Node {
    const alts = [this.branch()];
    while (this.peek() === '|') {
      this.i++;
      alts.push(this.branch());
    }
    return alts.length === 1 ? alts[0] : { t: 'alt', alts };
  }
  private branch(): Node {
    const items: Node[] = [];
    while (this.i < this.cps.length && this.peek() !== '|' && this.peek() !== ')') {
      items.push(this.piece());
    }
    return { t: 'seq', items };
  }
  private piece(): Node {
    const atom = this.atom();
    const c = this.peek();
    if (c === '*') return this.i++, { t: 'rep', node: atom, min: 0, max: Infinity };
    if (c === '+') return this.i++, { t: 'rep', node: atom, min: 1, max: Infinity };
    if (c === '?') return this.i++, { t: 'rep', node: atom, min: 0, max: 1 };
    if (c === '{') return this.range(atom);
    return atom;
  }
  private int(): number {
    const start = this.i;
    while (this.peek() !== undefined && /[0-9]/.test(this.peek()!)) this.i++;
    if (this.i === start) this.fail('expected a number in {n,m}');
    return Number(this.cps.slice(start, this.i).join(''));
  }
  private range(atom: Node): Node {
    this.i++; // {
    const min = this.int();
    let max = min;
    if (this.peek() === ',') {
      this.i++;
      max = this.peek() === '}' ? Infinity : this.int();
    }
    if (this.peek() !== '}') this.fail('expected "}"');
    this.i++;
    if (max < min) this.fail('{n,m} with n greater than m');
    return { t: 'rep', node: atom, min, max };
  }
  private atom(): Node {
    const c = this.peek();
    if (c === undefined) this.fail('unexpected end of pattern');
    if (c === '(') {
      this.i++;
      if (this.peek() === '?') this.fail('"(?" groups are not part of I-Regexp');
      const inner = this.regexp();
      if (this.peek() !== ')') this.fail('missing ")"');
      this.i++;
      return inner;
    }
    if (c === '.') {
      this.i++;
      return { t: 'char', test: (cp) => cp !== 0x0a && cp !== 0x0d };
    }
    if (c === '[') return this.charClassExpr();
    if (c === '\\') return { t: 'char', test: this.escape(false) };
    if (META.has(c)) this.fail(`"${c}" must be escaped`);
    this.i++;
    const cp = c.codePointAt(0)!;
    if (cp >= 0xd800 && cp <= 0xdfff) this.fail('lone surrogate');
    return { t: 'char', test: (x) => x === cp };
  }
  /** Parses `\x` at the cursor; returns a test, or (inClass) a code point for ranges. */
  private escape(inClass: true): CharTest | number;
  private escape(inClass: false): CharTest;
  private escape(inClass: boolean): CharTest | number {
    this.i++; // backslash
    const c = this.peek();
    if (c === undefined) this.fail('dangling "\\"');
    if (c === 'p' || c === 'P') {
      this.i++;
      if (this.peek() !== '{') this.fail(`expected "{" after \\${c}`);
      this.i++;
      const start = this.i;
      while (this.peek() !== undefined && this.peek() !== '}') this.i++;
      const prop = this.cps.slice(start, this.i).join('');
      if (this.peek() !== '}') this.fail('missing "}" in category escape');
      if (!CATEGORY.test(prop)) this.fail(`unknown category "${prop}" (I-Regexp allows general categories only)`);
      this.i++;
      return categoryTest(prop, c === 'P');
    }
    if (!SINGLE_ESC.has(c)) this.fail(`"\\${c}" is not an I-Regexp escape`);
    this.i++;
    const cp = escValue(c);
    return inClass ? cp : (x: number) => x === cp;
  }
  private charClassExpr(): Node {
    this.i++; // [
    let negate = false;
    if (this.peek() === '^') {
      negate = true;
      this.i++;
    }
    const tests: CharTest[] = [];
    let first = true;
    for (;;) {
      const c = this.peek();
      if (c === undefined) this.fail('missing "]"');
      if (c === ']') {
        if (first) this.fail('empty character class');
        this.i++;
        break;
      }
      if (c === '-') {
        // Allowed only first or last.
        if (first || this.cps[this.i + 1] === ']') {
          this.i++;
          tests.push((x) => x === 0x2d);
          first = false;
          continue;
        }
        this.fail('"-" must be first, last or escaped in a character class');
      }
      const lo = this.ccChar();
      first = false;
      if (typeof lo === 'function') {
        tests.push(lo);
        continue;
      }
      if (this.peek() === '-' && this.cps[this.i + 1] !== ']') {
        this.i++;
        const hi = this.ccChar();
        if (typeof hi === 'function') this.fail('a category escape cannot end a range');
        if (hi < lo) this.fail('character range out of order');
        tests.push((x) => x >= lo && x <= hi);
      } else {
        tests.push((x) => x === lo);
      }
    }
    const any = (x: number) => tests.some((t) => t(x));
    return { t: 'char', test: negate ? (x) => !any(x) : any };
  }
  private ccChar(): CharTest | number {
    const c = this.peek()!;
    if (c === '\\') return this.escape(true);
    if (c === '[' || c === ']') this.fail(`"${c}" must be escaped in a character class`);
    this.i++;
    return c.codePointAt(0)!;
  }
}

type State = { eps: number[]; edges: Array<{ test: CharTest; to: number }> };

function buildNfa(root: Node): { states: State[]; accept: number } {
  const states: State[] = [];
  const add = (): number => {
    if (states.length >= IREGEXP_MAX_STATES) {
      throw new IRegexpSyntaxError('pattern is too complex once repetitions are expanded', 0);
    }
    states.push({ eps: [], edges: [] });
    return states.length - 1;
  };
  const build = (n: Node, from: number): number => {
    switch (n.t) {
      case 'char': {
        const to = add();
        states[from].edges.push({ test: n.test, to });
        return to;
      }
      case 'seq': {
        let cur = from;
        for (const item of n.items) cur = build(item, cur);
        return cur;
      }
      case 'alt': {
        const end = add();
        for (const a of n.alts) {
          const s = add();
          states[from].eps.push(s);
          states[build(a, s)].eps.push(end);
        }
        return end;
      }
      case 'rep': {
        let cur = from;
        for (let k = 0; k < n.min; k++) cur = build(n.node, cur);
        if (n.max === Infinity) {
          const loop = add();
          states[cur].eps.push(loop);
          states[build(n.node, loop)].eps.push(loop);
          return loop;
        }
        const end = add();
        states[cur].eps.push(end);
        for (let k = n.min; k < n.max; k++) {
          cur = build(n.node, cur);
          states[cur].eps.push(end);
        }
        return end;
      }
    }
  };
  const start = add();
  const accept = build(root, start);
  return { states, accept };
}

function closure(states: State[], seeds: Iterable<number>): Set<number> {
  const out = new Set<number>();
  const stack = [...seeds];
  while (stack.length) {
    const s = stack.pop()!;
    if (out.has(s)) continue;
    out.add(s);
    for (const e of states[s].eps) if (!out.has(e)) stack.push(e);
  }
  return out;
}

/** Compile an RFC 9485 I-Regexp. Refuses patterns over 256 characters or outside the grammar. */
export function compileIRegexp(pattern: string): IRegexpResult {
  if (typeof pattern !== 'string') return { ok: false, error: 'pattern must be a string', index: 0 };
  if (pattern.length > IREGEXP_MAX_LENGTH) {
    return { ok: false, error: `pattern is longer than ${IREGEXP_MAX_LENGTH} characters`, index: IREGEXP_MAX_LENGTH };
  }
  try {
    const { states, accept } = buildNfa(new Parser(pattern).parse());
    const test = (input: string): boolean => {
      let cur = closure(states, [0]);
      for (const ch of input) {
        const cp = ch.codePointAt(0)!;
        const next: number[] = [];
        for (const s of cur) for (const e of states[s].edges) if (e.test(cp)) next.push(e.to);
        if (next.length === 0) return false;
        cur = closure(states, next);
      }
      return cur.has(accept);
    };
    return { ok: true, pattern, test };
  } catch (err) {
    if (err instanceof IRegexpSyntaxError) return { ok: false, error: err.message, index: err.index };
    throw err;
  }
}
