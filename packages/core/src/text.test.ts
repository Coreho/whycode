// Tests for text helpers: CRLF files must come back as CRLF, and text shown
// to a person keeps its line breaks and hidden characters visible.
import { describe, expect, it } from "vitest";
import {
  countLines,
  detectLineEnding,
  restoreLineEnding,
  toLf,
  visibleText,
} from "./text.js";

describe("line endings", () => {
  it("detects CRLF and LF files", () => {
    expect(detectLineEnding("a\r\nb\r\n")).toBe("\r\n");
    expect(detectLineEnding("a\nb\n")).toBe("\n");
    expect(detectLineEnding("single line")).toBe("\n");
  });

  it("round-trips CRLF text through LF", () => {
    const crlf = "one\r\ntwo\r\nthree\r\n";
    expect(toLf(crlf)).toBe("one\ntwo\nthree\n");
    expect(restoreLineEnding(toLf(crlf), "\r\n")).toBe(crlf);
  });

  it("leaves LF text alone when restoring LF", () => {
    expect(restoreLineEnding("a\nb\n", "\n")).toBe("a\nb\n");
  });
});

describe("countLines", () => {
  it("does not count a trailing newline as an extra line", () => {
    expect(countLines("a\nb")).toBe(2);
    expect(countLines("a\nb\n")).toBe(2);
  });

  it("counts an empty file as zero lines", () => {
    expect(countLines("")).toBe(0);
  });
});

describe("visibleText", () => {
  it("shows line breaks and hidden characters as escapes, on one line", () => {
    const [escape, override, lineSeparator] = [27, 0x202e, 0x2028].map((code) =>
      String.fromCharCode(code),
    );
    const shown = visibleText(
      `a\r\nb${escape}c${override}d${lineSeparator}e\tf`,
    );
    expect(shown).toBe(String.raw`a\r\nb\u{1b}c\u{202e}d\u{2028}e` + "\tf");
  });

  it("leaves ordinary text alone", () => {
    expect(visibleText("const café = 1;")).toBe("const café = 1;");
  });
});
