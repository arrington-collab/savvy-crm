import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Root flat config — discovered by each package's `eslint .` (flat config is
// resolved by walking up from cwd). apps/web has its own next-based config.
export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/.turbo/**",
      "**/drizzle/**",
      "apps/web/**", // app uses its own eslint config
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Phase 0 pragmatism: intentional non-null assertions (e.g. `[t]` from
      // .returning(), env vars) and casts are reviewed, not bugs.
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
