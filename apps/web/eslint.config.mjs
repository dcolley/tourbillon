import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';

export default defineConfig([
  ...nextVitals,
  // eslint-plugin-react-hooks@7 (via eslint-config-next) flags common
  // prop/localStorage sync patterns as errors. Keep as warn until those
  // call sites are refactored (keyed remount / lazy useState init).
  {
    rules: {
      'react-hooks/set-state-in-effect': 'warn',
    },
  },
  // CONCIERGE-QUEUE-SIGNAL softs S18 (#209) + S19a (#212) + S20a/S20b + S23a/S23b: the task-progress bridge
  // must not launder types through `as unknown as` (or its `any`/`never`/angle-bracket twins).
  // The S17 compile pins (`sliceRealDbModule`'s
  // `satisfies` + the type-level Asserts in the test) only have teeth if nothing re-erases the
  // real `@tourbillon/db` export types: writing `loadRealDbModule` as
  // `... as unknown as RealDbModuleSlice` satisfies tsc AND the Assert pins (the slice type is
  // still named), so the pins cannot tell it apart — eslint draws the line instead. Scoped to
  // the bridge (source + tests) on purpose: a repo-wide ban would police every other file's
  // reviewed double-casts, which is not what S18 asked for.
  //
  // S19a: Test's mutant sweep on #212 found two erasure channels the single selector missed —
  // the angle-bracket assertion `<unknown>x` (M8) and the `any` leg of `x as any as T` (M9)
  // both erased just as hard while sailing past the rule. One selector per channel; all three
  // are verified by mutants (and the scope is verified too: the same mutants in
  // task-progress-signals.ts must KEEP passing — the ban stays bridge-only by design).
  //
  // S20a/S20b: Test's #214 sweep found two more erasure twins the S19a set still missed —
  // the angle-bracket `any` `<T><any>x` (TSTypeAssertion twin of M9) and the `never` leg of
  // `(x as never) as T` (erases like `unknown`; `never` is assignable to everything). The
  // `never` rule matches only an `as never` LEG nested inside another cast, so the deliberate
  // single-step `controller as never` in getChatSession needs no eslint-disable — mutant-
  // verified both ways.
  //
  // S23a/S23b: Test's #218 sweep found the TSTypeAssertion twins of S20b still sailing through
  // — `<T><never>x`, `<T>(x as never)` and `(<never>x) as T` were green because both never
  // selectors only ranged over TSAsExpression parents/children. The same sweep also probed the
  // tail-leg selector too BROAD: its descendant combinator flagged ANY cast inside the operand
  // subtree of an `as never`, e.g. `f({ a: 1 } as T) as never` — a single-step `as never` over
  // a call, not a double cast. Fix: both never selectors now range over
  // `:matches(TSAsExpression, TSTypeAssertion)` on BOTH sides (one selector per leg) and use
  // the CHILD combinator — parentheses are not AST nodes, so a real double-cast leg is always a
  // direct child; the call-arg form goes green and bare `x as never` / `<never>x` stay green.
  {
    files: ['lib/assistant/task-progress-bridge.ts', 'lib/assistant/task-progress-bridge.test.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          // Matches the `as unknown` leg of any `x as unknown as T` double cast: the inner
          // TSAsExpression carries the TSUnknownKeyword annotation. Single-step casts
          // (`as Agent`, `as never`, intersections) stay allowed.
          selector: "TSAsExpression[typeAnnotation.type='TSUnknownKeyword']",
          message:
            'S18: `as unknown as` erases the real @tourbillon/db export types the sliceRealDbModule/satisfies pins depend on — keep casts single-step and typed (see task-progress-bridge.ts).',
        },
        {
          // S19a/M8: the angle-bracket twin of the selector above — `<unknown>x` (or
          // `<T><unknown>x`) is the same erasure written as a TSTypeAssertion.
          selector: "TSTypeAssertion[typeAnnotation.type='TSUnknownKeyword']",
          message:
            'S19a: `<unknown>x` erases types exactly like `as unknown as` — the S18 rule above applies to angle-bracket assertions too (see task-progress-bridge.ts).',
        },
        {
          // S19a/M9: the `any` leg of `x as any as T`. `any` disables every check on the
          // value it annotates, so a double cast laundering through it satisfies tsc while
          // erasing the same real export types `unknown` does. Deliberately broader than the
          // double-cast shape: a bare `as any` in the bridge would be the same hole one step
          // earlier, and the bridge currently has none — so nothing legitimate trips this.
          selector: "TSAsExpression[typeAnnotation.type='TSAnyKeyword']",
          message:
            'S19a: `as any` (including the `x as any as T` double cast) erases the real @tourbillon/db export types the S17/S18 pins depend on — keep casts single-step and typed (see task-progress-bridge.ts).',
        },
        {
          // S20a: the angle-bracket twin of the S19a/M9 selector — `<any>x` (or `<T><any>x`)
          // is `as any` written as a TSTypeAssertion, and erases exactly as hard. Same
          // deliberate breadth as M9: a bare `<any>x` in the bridge would be the same hole.
          selector: "TSTypeAssertion[typeAnnotation.type='TSAnyKeyword']",
          message:
            'S20a: `<any>x` erases types exactly like `as any` — the S19a rule above applies to angle-bracket assertions too (see task-progress-bridge.ts).',
        },
        {
          // S20b + S23a (lead leg): a `never`-annotated cast nested DIRECTLY inside another
          // cast. `never` is assignable to everything, so a chain touching it sails through
          // tsc while the value's real type is erased — the twin of the S18 `as unknown as`
          // selector. esquery matches concrete node kinds (the parser emits
          // `type: 'TSAsExpression'` / `type: 'TSTypeAssertion'`, with typeAnnotation holding
          // the bare keyword node — no TSTypeAnnotation wrapper), so the rule spans BOTH cast
          // forms on both sides via :matches: `(x as never) as T`, `x as T as never` (inner
          // child = the as-never leg), and the TSTypeAssertion twins Test probed green on
          // #218: `<T><never>x`, `<T>(x as never)`, `(<never>x) as T`. Child combinator, not
          // descendant: parentheses are not AST nodes, so a real double-cast leg is always a
          // direct child.
          // A bare single-step `as never` / `<never>x` is NOT nested, so the deliberate
          // `controller as never` in getChatSession (and the test's `signal as never`)
          // stay green without disables — mutant-verified both ways.
          selector:
            ":matches(TSAsExpression, TSTypeAssertion) > :matches(TSAsExpression[typeAnnotation.type='TSNeverKeyword'], TSTypeAssertion[typeAnnotation.type='TSNeverKeyword'])",
          message:
            'S20b/S23a: a `never` leg inside a multi-step cast (`(x as never) as T`, `<T><never>x`, `<T>(x as never)`, `(<never>x) as T`) erases types exactly like `as unknown as` — `never` is assignable everywhere; keep casts single-step and typed. A deliberate single-step `as never`/`<never>x` is fine (see task-progress-bridge.ts).',
        },
        {
          // S20b tail-leg twin + S23a: `x as T as never` — here the `as never` annotation sits
          // on the OUTER node, so the selector above (annotation on the child) cannot see it.
          // Same nesting gate, now spanning both cast forms: a never-annotated cast whose
          // operand is DIRECTLY another cast — covers the classic tail, the mixed
          // `(<T>x) as never`, and the angle-bracket tail `<never>(x as T)` / `<never><T>x`.
          // S23b: this used a DESCENDANT combinator, which flagged any cast anywhere in the
          // operand subtree — `f({ a: 1 } as SomeType) as never` was probed RED on #218 even
          // though the inner cast sits in a call argument (not a double cast). Tightened to
          // `>` so only the real double-cast tail leg fires; the call-arg form is green again.
          // A parenthesised `(x as T) as never` is AST-indistinguishable from the tail leg and
          // stays RED — deliberate (getChatSession's real shape is the BARE
          // `controller as never`, AST child = Identifier, which stays green).
          selector:
            ":matches(TSAsExpression[typeAnnotation.type='TSNeverKeyword'], TSTypeAssertion[typeAnnotation.type='TSNeverKeyword']) > :matches(TSAsExpression, TSTypeAssertion)",
          message:
            'S20b/S23a: reaching `never` as the tail of a multi-step cast (`x as T as never`, `(<T>x) as never`, `<never>(x as T)`) erases types exactly like `as unknown as` — keep casts single-step and typed. A deliberate single-step `as never`/`<never>x` is fine (see task-progress-bridge.ts).',
        },
      ],
    },
  },
  globalIgnores(['.next/**', 'node_modules/**']),
]);
