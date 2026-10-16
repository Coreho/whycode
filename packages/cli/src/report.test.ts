// Tests for terminal rendering that AI-written text can't abuse: hidden line
// breaks and control characters never reach the terminal as-is.
import { describe, expect, it } from "vitest";
import { painter, renderSuggestion } from "./report.js";

const plain = painter(false);

describe("renderSuggestion", () => {
  it("shows every line break as a new line and drops control characters", () => {
    const carriageReturn = String.fromCharCode(13);
    const lineSeparator = String.fromCharCode(0x2028);
    const escape = String.fromCharCode(27);
    const text = renderSuggestion(
      "a.py",
      {
        line: 3,
        original: "# old",
        suggested: `# new${carriageReturn}import os${lineSeparator}x${escape}[2Ky`,
        reason: "clearer",
      },
      { index: 1, total: 1 },
      plain,
    );
    expect(text).toContain("    + # new\n    + import os\n    + x[2Ky\n");
    expect(text).not.toContain(escape);
    expect(text).not.toContain(carriageReturn);
  });

  it("shows the reason on one line without hidden characters", () => {
    const escape = String.fromCharCode(27);
    const isolate = String.fromCharCode(0x2066);
    const text = renderSuggestion(
      "a.py",
      {
        line: 3,
        original: "# old",
        suggested: `# new${isolate}`,
        reason: `clearer\n${escape}[2Kwording${isolate}`,
      },
      { index: 1, total: 1 },
      plain,
    );
    expect(text).toContain("    + # new\n    why: clearer [2Kwording");
    expect(text).not.toContain(escape);
    expect(text).not.toContain(isolate);
  });
});
