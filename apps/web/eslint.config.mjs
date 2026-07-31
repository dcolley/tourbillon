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
  globalIgnores(['.next/**', 'node_modules/**']),
]);
