// S282-S5: eslint coverage for @tourbillon/company-computer. Before this, only
// apps/web had an eslint config, so `pnpm -r lint` silently skipped this package.
// Plain TS-recommended rules (no type-aware linting: keeps lint fast and free of
// tsconfig project wiring); runs via `pnpm lint` (root `pnpm -r lint`) and CI.
import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig([
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      globals: { process: "readonly", console: "readonly", Buffer: "readonly" },
    },
    rules: {
      // Dry-run HostClient stubs keep the interface signature; `_`-prefixed = intentionally unused.
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  globalIgnores(["node_modules/**"]),
]);
