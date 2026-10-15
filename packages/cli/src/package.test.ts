// Guards the published package's manifest. The core is bundled into the CLI,
// so the CLI must install exactly the core's runtime dependencies, except the
// grammar packages, whose .wasm files the build ships instead.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface Manifest {
  name?: string;
  private?: boolean;
  bin?: Record<string, string>;
  engines?: Record<string, string>;
  files?: string[];
  dependencies?: Record<string, string>;
}

const readManifest = (path: string): Manifest =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as Manifest;

const cli = readManifest("../package.json");
const core = readManifest("../../core/package.json");

describe("the whycode package", () => {
  it("is publishable as whycode with a whycode binary on Node 22.12+", () => {
    expect(cli.name).toBe("whycode");
    expect(cli.private).toBeUndefined();
    expect(cli.bin).toEqual({ whycode: "./dist/bin.js" });
    expect(cli.engines).toEqual({ node: ">=22.12" });
    expect(cli.files).toEqual(["dist"]);
  });

  it("depends on the core's runtime dependencies, minus the grammar packages", () => {
    const expected = Object.fromEntries(
      Object.entries(core.dependencies ?? {}).filter(
        ([name]) => !name.startsWith("tree-sitter-"),
      ),
    );
    expect(cli.dependencies).toEqual(expected);
  });
});
