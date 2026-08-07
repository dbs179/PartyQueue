// ESLint flat config. The two rule groups that matter most here:
// n/no-missing-import (broken relative imports — the class of bug that
// silently disabled DJ features pre-7.1.7) and no-unused-vars (dead wiring
// like the originally-unused asyncHandler).
import js from "@eslint/js";
import nodePlugin from "eslint-plugin-n";
import globals from "globals";

export default [
  {
    ignores: [
      "node_modules/**",
      "data/**",
      "playwright-report/**",
      "test-results/**",
      "public/vendor/**", // minified third-party bundles
      "public/js/dist/**", // esbuild client bundle + sourcemaps
    ],
  },
  js.configs.recommended,
  {
    // Rules that don't fit this codebase:
    // - no-control-regex: \x00-\x1f sanitizers are deliberate throughout.
    // - no-useless-assignment: init-then-overwrite style is used widely.
    // - no-empty: empty catch with an explanatory comment is the norm here.
    rules: {
      "no-control-regex": "off",
      "no-useless-assignment": "off",
      "preserve-caught-error": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrors: "none",
        },
      ],
    },
  },
  {
    files: ["src/**/*.js", "scripts/**/*.mjs", "test/**/*.js", "*.js", "*.mjs"],
    plugins: { n: nodePlugin },
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: globals.nodeBuiltin,
    },
    rules: {
      "n/no-missing-import": "error",
    },
  },
  {
    // Playwright specs run node-side but evaluate snippets in the browser.
    files: ["e2e/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: { ...globals.nodeBuiltin, ...globals.browser },
    },
  },
  {
    files: ["public/js/**/*.js"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: globals.browser,
    },
  },
];
