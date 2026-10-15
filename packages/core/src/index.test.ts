// Smoke test proving the toolchain works: ESM import, TypeScript, Vitest.
import { describe, expect, it } from "vitest";
import { version } from "./index.js";

describe("@whycode/core entry point", () => {
  it("exports a semver version string", () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
