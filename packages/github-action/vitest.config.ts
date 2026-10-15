// Runs action tests against core source and verifies the built standalone bundle.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@whycode\/core\/testing$/,
        replacement: fileURLToPath(
          new URL("../core/src/testing/index.ts", import.meta.url),
        ),
      },
      {
        find: /^@whycode\/core$/,
        replacement: fileURLToPath(
          new URL("../core/src/index.ts", import.meta.url),
        ),
      },
    ],
  },
});
