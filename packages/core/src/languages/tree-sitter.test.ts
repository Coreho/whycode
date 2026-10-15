// Tests for the shared tree-sitter token extraction behind the
// logic-unchanged check.
import { describe, expect, it } from "vitest";
import type { GrammarSpec, TokenRules } from "./tree-sitter.js";
import {
  loadGrammar,
  SYNTAX_ERROR_TOKEN,
  treeSitterTokens,
} from "./tree-sitter.js";

const JAVASCRIPT: GrammarSpec = {
  packageName: "tree-sitter-javascript",
  wasmFile: "tree-sitter-javascript.wasm",
};
const RULES: TokenRules = { commentTypes: new Set(["comment"]) };
const tokens = (code: string) => treeSitterTokens(code, JAVASCRIPT, RULES);

describe("treeSitterTokens", () => {
  it("leaves comments out of the token stream", async () => {
    expect(await tokens("let x = 1; // one\n/* two */ x++")).toEqual([
      "let",
      "x",
      "=",
      "1",
      ";",
      "x",
      "++",
    ]);
  });

  it("ignores whitespace between tokens", async () => {
    expect(await tokens("let   x =\n  1 ;")).toEqual(await tokens("let x=1;"));
  });

  it("keeps the inside of template literals exact, including comment-like text", async () => {
    const result = await tokens("const s = `a\n// b`;");
    expect(result).toContain("a\n// b");
  });

  it("marks syntax errors, so code that newly breaks produces a different stream", async () => {
    const broken = await tokens("let x = (1;");
    expect(broken.some((token) => token.startsWith("<<"))).toBe(true);
    expect(broken).not.toEqual(await tokens("let x = (1);"));
  });

  it("emits a syntax-error marker for ERROR nodes", async () => {
    expect(await tokens("1 + 2 * * 3")).toContain(SYNTAX_ERROR_TOKEN);
  });

  it("handles non-ASCII text", async () => {
    expect(await tokens("const é = 'ü';")).toEqual([
      "const",
      "é",
      "=",
      "'",
      "ü",
      "'",
      ";",
    ]);
  });

  it("walks deeply nested code without overflowing the call stack", async () => {
    const depth = 3000;
    const code = `x = ${"(".repeat(depth)}1${")".repeat(depth)}`;
    expect(await tokens(code)).toHaveLength(depth * 2 + 3);
  });
});

describe("loadGrammar", () => {
  it("loads each grammar only once", () => {
    expect(loadGrammar(JAVASCRIPT)).toBe(loadGrammar(JAVASCRIPT));
  });
});
