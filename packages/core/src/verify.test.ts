// Tests for the token-stream comparison behind the logic-unchanged check.
import { describe, expect, it } from "vitest";
import { compareTokenStreams, describeTokenMismatch } from "./verify.js";

describe("compareTokenStreams", () => {
  it("reports equal streams as equal", () => {
    expect(compareTokenStreams(["x", "=", "1"], ["x", "=", "1"])).toEqual({
      equal: true,
    });
  });

  it("reports the first differing token", () => {
    expect(compareTokenStreams(["x", "=", "1"], ["x", "=", "2"])).toEqual({
      equal: false,
      index: 2,
      expected: "1",
      actual: "2",
    });
  });

  it("catches tokens added or removed at the end", () => {
    expect(compareTokenStreams(["a"], ["a", "b"])).toMatchObject({
      equal: false,
      index: 1,
      expected: undefined,
      actual: "b",
    });
    expect(compareTokenStreams(["a", "b"], ["a"])).toMatchObject({
      equal: false,
      index: 1,
      expected: "b",
      actual: undefined,
    });
  });
});

describe("describeTokenMismatch", () => {
  it("explains a mismatch in words, counting tokens from 1", () => {
    const comparison = compareTokenStreams(["a", "b"], ["a"]);
    expect(describeTokenMismatch(comparison)).toBe(
      'token 2: expected "b", found end of code',
    );
  });
});
