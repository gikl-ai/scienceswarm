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
    "dist/**",
    ".desktop-package/**",
    ".worktrees/**",
    "next-env.d.ts",
    // Tutorial-generated artifacts: scripts emit data/ and output/ folders
    // (e.g. plotly.js, jquery, crosstalk bundles emitted by htmlwidgets).
    // These are gitignored per-tutorial but materialize on any dev's
    // machine that runs the pipeline.
    "docs/tutorials/*/data/**",
    "docs/tutorials/*/output/**",
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
  // Design-system layering gate: application code imports the ss-* wrapper
  // layer (re-exported from "@/components/ui" / "@/components/ui/ss-*")
  // instead of reaching past it to the raw shadcn primitives. See
  // docs/_local/reference/COMPONENT_ARCHITECTURE.md §3. The raw primitives
  // themselves (src/components/ui/button.tsx, dialog.tsx, ...) are fine —
  // only app code is scoped here, so the wrappers can still import them.
  {
    files: [
      "src/app/**/*.{ts,tsx}",
      "src/components/research/**/*.{ts,tsx}",
      "src/components/setup/**/*.{ts,tsx}",
      "src/components/skills/**/*.{ts,tsx}",
      "src/components/radar/**/*.{ts,tsx}",
      "src/components/runtime/**/*.{ts,tsx}",
      "src/components/settings/**/*.{ts,tsx}",
      "src/components/openclaw/**/*.{ts,tsx}",
      "src/components/progress/**/*.{ts,tsx}",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@/components/ui/*",
                "!@/components/ui/ss-*",
                "!@/components/ui/index",
              ],
              message:
                "Import the ss-* wrapper from @/components/ui instead of the raw primitive (see docs/_local/reference/COMPONENT_ARCHITECTURE.md §3).",
            },
          ],
        },
      ],
    },
  },
]);

export default eslintConfig;
