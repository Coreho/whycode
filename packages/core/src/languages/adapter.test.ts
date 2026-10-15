// Tests for choosing a language by file path: full adapters first, then the
// comment-only fallback table.
import { describe, expect, it } from "vitest";
import { createToyAdapter } from "../testing/toy-adapter.js";
import { findAdapterForPath } from "./adapter.js";
import { findCommentOnlyLanguage } from "./fallback.js";

describe("findAdapterForPath", () => {
  const adapters = [createToyAdapter()];

  it("matches by extension, ignoring case", () => {
    expect(findAdapterForPath("src/game.toy", adapters)?.id).toBe("toy");
    expect(findAdapterForPath("SRC\\GAME.TOY", adapters)?.id).toBe("toy");
  });

  it("returns undefined for other or missing extensions", () => {
    expect(findAdapterForPath("src/app.py", adapters)).toBeUndefined();
    expect(findAdapterForPath("Makefile", adapters)).toBeUndefined();
  });
});

describe("findCommentOnlyLanguage", () => {
  it("knows the comment syntax of common unsupported languages", () => {
    expect(findCommentOnlyLanguage("app.rb")).toEqual({
      id: "ruby",
      lineComment: "#",
    });
    expect(findCommentOnlyLanguage("main.cpp")).toEqual({
      id: "cpp",
      lineComment: "//",
    });
    expect(findCommentOnlyLanguage("query.sql")).toEqual({
      id: "sql",
      lineComment: "--",
    });
  });

  it("returns undefined for unknown extensions", () => {
    expect(findCommentOnlyLanguage("data.xyz")).toBeUndefined();
  });
});
