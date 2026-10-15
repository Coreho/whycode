// Tests run against the core's TypeScript source, so they don't need a
// fresh build of @whycode/core first. Some tests drive real git
// subprocesses, which can pass Vitest's 5-second default when the whole
// suite runs in parallel, so tests get longer to finish.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const coreSource = (path: string) =>
  fileURLToPath(new URL(`../core/src/${path}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@whycode\/core\/testing$/,
        replacement: coreSource("testing/index.ts"),
      },
      { find: /^@whycode\/core$/, replacement: coreSource("index.ts") },
    ],
  },
  test: {
    testTimeout: 30_000,
  },
});
