// Tests run without VS Code: "vscode" resolves to a hand-written fake of
// the API, and @whycode/core to the core's TypeScript source, so they don't
// need a fresh build of the core either.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const source = (path: string) =>
  fileURLToPath(new URL(`../${path}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^vscode$/,
        replacement: source("vscode/src/testing/fake-vscode.ts"),
      },
      {
        find: /^@whycode\/core\/testing$/,
        replacement: source("core/src/testing/index.ts"),
      },
      { find: /^@whycode\/core$/, replacement: source("core/src/index.ts") },
    ],
  },
});
