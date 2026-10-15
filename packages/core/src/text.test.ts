// Tests for line-ending helpers: CRLF files must come back as CRLF.
import { describe, expect, it } from "vitest";
import {
  countLines,
  detectLineEnding,
  restoreLineEnding,
  toLf,
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
