import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

import requireAttribution from "./tooling/eslint-rules/require-attribution.mjs";

const scienceswarmRules = {
  rules: {
    "require-attribution": requireAttribution,
  },
};

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    files: ["**/*.{ts,tsx,mts,mjs,js,jsx}"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  // ScienceSwarm custom plugin: attribution gate for gbrain write sites.
  // Scoped to src/** so test files, scripts, and tooling are exempt.
  // This keeps the attribution gate on shipped write paths only.
  {
    files: ["src/**/*.{ts,tsx,mts,mjs,js,jsx}"],
    plugins: {
      scienceswarm: scienceswarmRules,
    },
    rules: {
      "scienceswarm/require-attribution": "error",
    },
  },
  // Allowlist: files that legitimately do not need the import.
  //   - gbrain-installer.ts defines the helper itself.
  //   - gbrain-runtime.mjs is the runtime bridge and never writes.
  //   - init.ts runs at startup and has no authenticated user yet.
  {
    files: [
      "src/lib/setup/gbrain-installer.ts",
      "src/brain/stores/gbrain-runtime.mjs",
      "src/brain/init.ts",
    ],
    rules: {
      "scienceswarm/require-attribution": "off",
    },
  },
]);

export default eslintConfig;
