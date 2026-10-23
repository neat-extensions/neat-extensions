import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: [".browsers/", ".scratch/", "node_modules/", "dist/", "dist-*/", "test-results/", "playwright-report/", "store/", ".pw-*/"] },
  js.configs.recommended,
  {
    files: ["packages/**/*.js", "apps/**/*.js"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: { ...globals.browser, ...globals.webextensions, process: "readonly" },
    },
    rules: {
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "no-script-url": "error",
      "no-restricted-properties": [
        "error",
        { property: "innerHTML", message: "Build DOM with createElement/textContent." },
        { property: "outerHTML", message: "Build DOM with createElement/textContent." },
        { property: "insertAdjacentHTML", message: "Build DOM with createElement/textContent." },
        { object: "document", property: "write", message: "Never." },
      ],
      "no-restricted-globals": ["error", { name: "setInterval", message: "No polling: use events or chrome.alarms." }],
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["scripts/**/*.mjs", "tools/**/*.mjs", "tests/**/*.js", "tests/**/*.mjs", "*.config.js", "*.config.mjs"],
    languageOptions: { ecmaVersion: 2024, sourceType: "module", globals: { ...globals.node, ...globals.browser, chrome: "readonly" } },
    rules: { "no-unused-vars": ["error", { argsIgnorePattern: "^_" }] },
  },
];
