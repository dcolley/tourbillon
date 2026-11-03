// S316-S4 / S322-S4: eslint coverage for @tourbillon/scheduler. Before this, shared and
// scheduler carried no eslint config, so `pnpm -r lint` silently skipped them and
// the harness adapters (hermes-adapter / opencode-adapter / wake-runner) were never
// linted. Same shape as packages/company-computer (S282-S5): plain TS-recommended
// rules, no type-aware linting (fast, no tsconfig project wiring). Runs via
// `pnpm lint` (root `pnpm -r lint`) and CI (.github/workflows/ci.yml).
import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig([
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.mjs"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        setImmediate: "readonly",
        clearImmediate: "readonly",
        queueMicrotask: "readonly",
        structuredClone: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        AbortController: "readonly",
        AbortSignal: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        fetch: "readonly",
        Response: "readonly",
        Request: "readonly",
        Headers: "readonly",
        crypto: "readonly",
        performance: "readonly",
      },
    },
    rules: {
      // `_`-prefixed = intentionally unused (interface-shaped stubs, destructure-to-omit).
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Test-only relaxations, scoped so product code (adapters, wake-runner, harness drive)
    // stays under the full rule set. The fake-DB suites hook `Module.prototype.require`
    // (needs `require('module')` and forwards the original `arguments`), and fixtures cast
    // partial Mastra span / drizzle shapes with `as any`.
    files: ["**/*.test.ts", "**/__tests__/**/*.ts", "**/__fixtures__/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-require-imports": "off",
      "prefer-rest-params": "off",
    },
  },
  globalIgnores(["node_modules/**", "dist/**"]),
]);
