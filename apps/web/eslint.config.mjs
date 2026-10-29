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
  // CONCIERGE-QUEUE-SIGNAL softs S18 (#209) + S19a (#212) + S20a/S20b: the task-progress bridge
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
          // S20b: the `never` leg of `(x as never) as T` / `x as T as never`. `never` is
          // assignable to everything, so a chain touching it sails through tsc while the
          // value's real type is erased — the twin of the S18 `as unknown as` selector.
          // esquery matches concrete node kinds (the parser emits `type: 'TSAsExpression'`
          // for both union variants, with typeAnnotation holding the bare keyword node —
          // no TSTypeAnnotation wrapper), so the rule is: ANY `as never` leg NESTED inside
          // another cast is banned — both the leading leg `(x as never) as T` (inner child
          // = the as-never leg) and the tail leg `x as T as never` (outer = as-never) are
          // covered by the two selectors below.
          // A bare single-step `as never` is NOT nested, so the deliberate
          // `controller as never` in getChatSession (and the test's `signal as never`)
          // stay green without disables — mutant-verified both ways.
          selector: "TSAsExpression > TSAsExpression[typeAnnotation.type='TSNeverKeyword']",
          message:
            'S20b: an `as never` leg inside a multi-step cast (`(x as never) as T`, `x as T as never`) erases types exactly like `as unknown as` — `never` is assignable everywhere; keep casts single-step and typed. A deliberate single-step `as never` is fine (see task-progress-bridge.ts).',
        },
        {
          // S20b tail-leg twin: `x as T as never` — here the `as never` annotation sits on
          // the OUTER node, so the selector above (annotation on the child) cannot see it.
          // Same nesting gate: a never-annotated cast CONTAINING another cast. Note the
          // AST: typeAnnotation is the bare keyword node (no TSTypeAnnotation wrapper),
          // and the operand subtree includes the inner cast's own typeAnnotation. A
          // parenthesised single-step `(x as T) as never` is AST-indistinguishable from
          // the tail leg and is caught too — deliberate (getChatSession's real shape is
          // the BARE `controller as never`, AST child = Identifier, which stays green).
          selector: "TSAsExpression[typeAnnotation.type='TSNeverKeyword'] TSAsExpression",
          message:
            'S20b: reaching `as never` as the tail of a multi-step cast (`x as T as never`) erases types exactly like `as unknown as` — keep casts single-step and typed. A deliberate single-step `as never` is fine (see task-progress-bridge.ts).',
        },
      ],
    },
  },
  globalIgnores(['.next/**', 'node_modules/**']),
]);
