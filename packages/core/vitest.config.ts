// Some core tests run real formatters (CSharpier, google-java-format,
// rustfmt). Their cold start can pass Vitest's 5-second default when the
// whole suite runs in parallel, so tests here get longer to finish.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 30_000,
  },
});
