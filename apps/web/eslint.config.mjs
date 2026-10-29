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
  // CONCIERGE-QUEUE-SIGNAL softs S18 (#209): the task-progress bridge must not launder types
  // through `as unknown as`. The S17 compile pins (`sliceRealDbModule`'s `satisfies` + the
  // type-level Asserts in the test) only have teeth if nothing re-erases the real
  // `@tourbillon/db` export types: writing `loadRealDbModule` as
  // `... as unknown as RealDbModuleSlice` satisfies tsc AND the Assert pins (the slice type is
  // still named), so the pins cannot tell it apart — eslint draws the line instead. Scoped to
  // the bridge (source + tests) on purpose: a repo-wide ban would police every other file's
  // reviewed double-casts, which is not what S18 asked for.
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
      ],
    },
  },
  globalIgnores(['.next/**', 'node_modules/**']),
]);
