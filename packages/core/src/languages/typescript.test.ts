// Tests for the TypeScript/JavaScript adapters: Prettier formatting with the
// project's settings, tree-sitter tokens, and picking the right dialect.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findAdapterForPath } from "./adapter.js";
import { defaultAdapters } from "./index.js";
import {
  formatWithPrettier,
  javascriptAdapter,
  tsxAdapter,
  typescriptAdapter,
} from "./typescript.js";

describe("formatWithPrettier", () => {
  it("formats code, choosing the parser from the file extension", async () => {
    const result = await formatWithPrettier("const x:number=1", "example.ts");
    expect(result).toEqual({ code: "const x: number = 1;\n", formatted: true });
  });

  it("gives the same result when run twice", async () => {
    const once = await formatWithPrettier(
      "function f(a,b){return a+b}",
      "example.js",
    );
    const twice = await formatWithPrettier(once.code, "example.js");
    expect(twice.code).toBe(once.code);
  });

  it("uses the project's .prettierrc found from the file's location", async () => {
    const dir = await mkdtemp(join(tmpdir(), "whycode-prettier-"));
    try {
      await writeFile(
        join(dir, ".prettierrc"),
        JSON.stringify({ semi: false }),
      );
      const result = await formatWithPrettier(
        "const x = 1;",
        join(dir, "app.ts"),
      );
      expect(result.code).toBe("const x = 1\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects code with syntax errors", async () => {
    await expect(
      formatWithPrettier("const = ;", "example.ts"),
    ).rejects.toThrow();
  });

  it("falls back to the dialect's parser when no path is given", async () => {
    const result = await tsxAdapter.format("const a=<b>hi</b>");
    expect(result.code).toBe("const a = <b>hi</b>;\n");
  });
});

describe("script tokens", () => {
  it("ignores line, block, and doc comments in TypeScript", async () => {
    const plain = await typescriptAdapter.tokens("const x: number = 1;");
    const commented = await typescriptAdapter.tokens(
      "/** The answer. */\n// line\nconst x: number = /* block */ 1;",
    );
    expect(commented).toEqual(plain);
  });

  it.each([
    ["an identifier", "const y: number = a + 1;"],
    ["an operator", "const x: number = a - 1;"],
    ["a literal", "const x: number = a + 2;"],
    ["a string's contents", 'const x: number = a + "1";'],
  ])("notices a change to %s", async (_change, edited) => {
    const original = await typescriptAdapter.tokens("const x: number = a + 1;");
    expect(await typescriptAdapter.tokens(edited)).not.toEqual(original);
  });

  it("notices comment-like text added to JSX children", async () => {
    const before = await tsxAdapter.tokens("const a = <p>\n  hi\n</p>;");
    const after = await tsxAdapter.tokens(
      "const a = <p>\n  // note\n  hi\n</p>;",
    );
    expect(after).not.toEqual(before);
  });

  it("parses JSX in plain .js files", async () => {
    const result = await javascriptAdapter.tokens("const a = <p>hi</p>;");
    expect(result).toContain("hi");
    expect(result.some((token) => token.startsWith("<<"))).toBe(false);
  });
});

describe("defaultAdapters", () => {
  it.each([
    ["app.py", "python"],
    ["stubs.pyi", "python"],
    ["index.ts", "typescript"],
    ["types.d.ts", "typescript"],
    ["module.mts", "typescript"],
    ["Card.tsx", "tsx"],
    ["main.js", "javascript"],
    ["Card.jsx", "javascript"],
    ["config.cjs", "javascript"],
  ])("handles %s with the %s adapter", (path, adapterId) => {
    expect(findAdapterForPath(path, defaultAdapters)?.id).toBe(adapterId);
  });
});
