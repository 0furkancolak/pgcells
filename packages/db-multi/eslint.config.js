// ESLint 9 flat config: typescript-eslint recommended rules + the intent of the earlier Biome rules. No formatter (Prettier).
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  { ignores: ["**/*.gen.ts", "**/dist/**", "**/node_modules/**"] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "@typescript-eslint/no-import-type-side-effects": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "no-duplicate-imports": "error",
      "sort-imports": ["error", { ignoreCase: true, ignoreDeclarationSort: true }],
    },
  },
  { files: ["**/*.{js,mjs}"], languageOptions: { globals: { Buffer: "readonly", Bun: "readonly", console: "readonly", process: "readonly" } } },
);
