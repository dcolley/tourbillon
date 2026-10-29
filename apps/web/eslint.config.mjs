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
  // CONCIERGE-QUEUE-SIGNAL softs S18 (#209) + S19a (#212): the task-progress bridge must not
  // launder types through `as unknown as`. The S17 compile pins (`sliceRealDbModule`'s
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
      ],
    },
  },
  globalIgnores(['.next/**', 'node_modules/**']),
]);
