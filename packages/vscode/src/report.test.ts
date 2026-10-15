// Tests for the output channel text: no code and no secrets in the log.
import { describe, expect, it } from "vitest";
import { emptyTally, forLog, renderTally, summarize } from "./report.js";

describe("forLog", () => {
  it("keeps only the first line, so code frames under an error stay out", () => {
    expect(forLog("Unexpected token (3:5)\n> 3 | const x = ;")).toBe(
      "Unexpected token (3:5)",
    );
  });

  it("masks quoted code", () => {
    expect(
      forLog('tokens changed (token 4: expected "total", found `sum`)'),
    ).toBe('tokens changed (token 4: expected "...", found "...")');
  });

  it("redacts anything that looks like a secret", () => {
    const key = "sk-ant-api03-" + "x".repeat(40);
    expect(forLog(`request failed for ${key}`)).not.toContain(key);
  });
});

describe("renderTally and summarize", () => {
  it("groups skipped paths by reason and lists each outcome", () => {
    const tally = emptyTally();
    tally.skipped.push(
      { path: "a.lock", reason: "unsupported file type" },
      { path: "b.lock", reason: "unsupported file type" },
    );
    tally.written.push("app.py");
    expect(renderTally(tally)).toEqual([
      "Skipped 2 paths:",
      "  unsupported file type:",
      "    a.lock",
      "    b.lock",
      "Written (1):",
      "  app.py",
    ]);
    expect(summarize(tally)).toBe("1 written, 2 skipped.");
  });

  it("says when there was nothing to do", () => {
    expect(summarize(emptyTally())).toBe("nothing to do.");
  });
});
