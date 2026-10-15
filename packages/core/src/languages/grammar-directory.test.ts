// Tests for useGrammarDirectory, which bundled front-ends call so grammars
// load from their own folder of .wasm files instead of the npm packages.
// Kept in its own file: the setting and the grammar cache are per process.
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { goAdapter } from "./go.js";
import { pythonAdapter } from "./python.js";
import { useGrammarDirectory } from "./tree-sitter.js";

describe("useGrammarDirectory", () => {
  let directory: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "whycode-grammars-"));
    const require = createRequire(import.meta.url);
    const pythonPackage = dirname(
      require.resolve("tree-sitter-python/package.json"),
    );
    await copyFile(
      join(pythonPackage, "tree-sitter-python.wasm"),
      join(directory, "tree-sitter-python.wasm"),
    );
    useGrammarDirectory(directory);
  });

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("loads grammars from the given folder", async () => {
    expect(await pythonAdapter.tokens("x = 1  # one\n")).toEqual([
      "x",
      "=",
      "1",
    ]);
  });

  it("no longer falls back to the npm package", async () => {
    await expect(goAdapter.tokens("package main\n")).rejects.toThrow();
  });
});
