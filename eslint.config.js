import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/", "src-tauri/target/", "src-tauri/gen/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { "react-hooks": reactHooks },
    rules: {
      // F13: would have caught the F4 conditional-hook crashes
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // browser-emulating harness scripts (test/gui-mock) run in-page
    files: ["test/gui-mock/**/*.js"],
    languageOptions: {
      globals: {
        window: "readonly",
        document: "readonly",
        console: "readonly",
        fetch: "readonly",
        alert: "readonly",
        URL: "readonly",
        // #167: the in-page import runner schedules its scripted child
        // over timers (mock.js's window-sandbox emulation)
        setTimeout: "readonly",
        clearTimeout: "readonly",
      },
    },
  },
);
