// Tests for command-line parsing: commands, flag values and usage errors.
import { describe, expect, it } from "vitest";
import { parseCommandLine } from "./args.js";

describe("parseCommandLine", () => {
  it("parses check with paths and flags in any order", () => {
    expect(
      parseCommandLine([
        "check",
        "--comment-level",
        "medium",
        "src",
        "lib/a.py",
        "--provider=openrouter",
        "--model",
        "claude-opus-5-5",
      ]),
    ).toEqual({
      kind: "check",
      paths: ["src", "lib/a.py"],
      overrides: {
        commentLevel: "medium",
        provider: "openrouter",
        model: "claude-opus-5-5",
      },
    });
  });

  it("leaves unset flags out, so the config file decides", () => {
    expect(parseCommandLine(["check", "."])).toEqual({
      kind: "check",
      paths: ["."],
      overrides: {},
    });
  });

  it("recognizes help and version", () => {
    expect(parseCommandLine(["--help"])).toEqual({ kind: "help" });
    expect(parseCommandLine(["check", "-h"])).toEqual({ kind: "help" });
    expect(parseCommandLine(["-v"])).toEqual({ kind: "version" });
  });

  it.each([
    [[], /Missing a command/],
    [["lint", "."], /Unknown command "lint"/],
    [["check"], /needs at least one file or directory/],
    [
      ["check", ".", "--comment-level", "loud"],
      /light, medium or heavy, not "loud"/,
    ],
    [
      ["check", ".", "--provider", "openai"],
      /anthropic or openrouter, not "openai"/,
    ],
    [
      ["check", ".", "--provider", "host"],
      /only works inside Claude Code or VS Code/,
    ],
    [["check", ".", "--model", " "], /needs a model name/],
    [["check", ".", "--yes"], /--yes doesn.t apply to "whycode check"/],
    [
      ["check", ".", "--refactor"],
      /--refactor doesn.t apply to "whycode check"/,
    ],
    [["fix", ".", "--yes", "--refactor"], /can.t be combined with --refactor/],
    [["fix", ".", "--bogus"], /Unknown option .--bogus./],
  ])("rejects %j", (argv, message) => {
    const parsed = parseCommandLine(argv);
    expect(parsed.kind).toBe("error");
    expect(parsed.kind === "error" && parsed.message).toMatch(message);
    expect(parsed.kind === "error" && parsed.message).toMatch(/whycode --help/);
  });
});
