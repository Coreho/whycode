// Tests for the Python adapter: tree-sitter tokens and Ruff formatting.
// Ruff is an external binary, so formatting is tested against a fake process
// runner, plus a real run that only happens where Ruff is installed.
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { ProcessResult, ProcessRunner } from "../process.js";
import {
  createPythonAdapter,
  formatWithRuff,
  pythonAdapter,
} from "./python.js";
import { COMMENT_AFTER_CONTINUATION_TOKEN } from "./tree-sitter.js";

const ruffInstalled = spawnSync("ruff", ["--version"]).error === undefined;

function fakeRunner(result: ProcessResult) {
  const calls: { command: string; args: readonly string[]; stdin: string }[] =
    [];
  const run: ProcessRunner = (command, args, stdin) => {
    calls.push({ command, args, stdin });
    return Promise.resolve(result);
  };
  return { run, calls };
}

describe("python tokens", () => {
  it("ignores comments and whitespace between tokens", async () => {
    const plain = await pythonAdapter.tokens("def f(x):\n    return x\n");
    const commented = await pythonAdapter.tokens(
      "# helper\ndef f( x ):\n    # identity\n    return x\n",
    );
    expect(commented).toEqual(plain);
  });

  it.each([
    ["an identifier", "total = price * count\n"],
    ["an operator", "total = price + qty\n"],
    ["a literal", "total = price * 2\n"],
  ])("notices a change to %s", async (_change, edited) => {
    const original = await pythonAdapter.tokens("total = price * qty\n");
    expect(await pythonAdapter.tokens(edited)).not.toEqual(original);
  });

  it("notices text added inside a triple-quoted string", async () => {
    const before = await pythonAdapter.tokens('s = """a\nb"""\n');
    const after = await pythonAdapter.tokens('s = """a\n# note\nb"""\n');
    expect(after).not.toEqual(before);
  });

  it("notices a comment placed after a backslash line continuation", async () => {
    // Tree-sitter parses this without error, but Python rejects it.
    const before = await pythonAdapter.tokens("x = 1 + \\\n    2\n");
    const after = await pythonAdapter.tokens("x = 1 + \\\n    # note\n    2\n");
    expect(after).toContain(COMMENT_AFTER_CONTINUATION_TOKEN);
    expect(after).not.toEqual(before);
  });

  it.each([
    ["call arguments", "f(\n    a, b\n)\n", "f(\n    a,\n    b,\n)\n"],
    [
      "parameters",
      "def f(\n    a, b\n): ...\n",
      "def f(\n    a,\n    b,\n): ...\n",
    ],
    [
      "a dict",
      "d = {\n    1: a, 2: b\n}\n",
      "d = {\n    1: a,\n    2: b,\n}\n",
    ],
    [
      "imports",
      "from m import (\n    a, b\n)\n",
      "from m import (\n    a,\n    b,\n)\n",
    ],
    ["a two-item tuple", "t = (\n    a, b\n)\n", "t = (\n    a,\n    b,\n)\n"],
    [
      "a two-item subscript",
      "v = m[\n    a, b\n]\n",
      "v = m[\n    a,\n    b,\n]\n",
    ],
  ])(
    "ignores the trailing comma Ruff adds when it splits %s",
    async (_list, hugged, split) => {
      expect(await pythonAdapter.tokens(split)).toEqual(
        await pythonAdapter.tokens(hugged),
      );
    },
  );

  it.each([
    ["a value into a one-item tuple", "y = (x)\n", "y = (x,)\n"],
    ["an index into a tuple index", "y = a[b]\n", "y = a[b,]\n"],
    [
      "a capture pattern into a sequence pattern",
      "match p:\n    case (a):\n        pass\n",
      "match p:\n    case (a,):\n        pass\n",
    ],
  ])(
    "notices a trailing comma that turns %s",
    async (_change, before, after) => {
      expect(await pythonAdapter.tokens(after)).not.toEqual(
        await pythonAdapter.tokens(before),
      );
    },
  );
});

describe("formatWithRuff", () => {
  it("sends the code to `ruff format` on stdin, with the file path for config lookup", async () => {
    const { run, calls } = fakeRunner({
      kind: "completed",
      exitCode: 0,
      stdout: "x = 1\n",
      stderr: "",
    });
    expect(await formatWithRuff("x=1", "src/app.py", run)).toEqual({
      code: "x = 1\n",
      formatted: true,
    });
    expect(calls).toEqual([
      {
        command: "ruff",
        args: ["format", "--quiet", "--stdin-filename", "src/app.py", "-"],
        stdin: "x=1",
      },
    ]);
  });

  it("returns the code unchanged when Ruff isn't installed", async () => {
    const { run } = fakeRunner({ kind: "not-found" });
    expect(await formatWithRuff("x=1", undefined, run)).toEqual({
      code: "x=1",
      formatted: false,
    });
  });

  it("throws with Ruff's message when it can't format the code", async () => {
    const { run } = fakeRunner({
      kind: "completed",
      exitCode: 2,
      stdout: "",
      stderr:
        "error: Failed to parse app.py:1:3: Expected an expression\nmore detail",
    });
    await expect(formatWithRuff("x =", "app.py", run)).rejects.toThrow(
      "ruff format failed (exit code 2): error: Failed to parse app.py:1:3: Expected an expression",
    );
  });

  it("is what the adapter's format uses", async () => {
    const { run, calls } = fakeRunner({ kind: "not-found" });
    await createPythonAdapter({ runProcess: run }).format("x=1", "a.py");
    expect(calls).toHaveLength(1);
  });

  it.skipIf(!ruffInstalled)("formats with the real Ruff binary", async () => {
    expect(await pythonAdapter.format("x=1\n", "example.py")).toEqual({
      code: "x = 1\n",
      formatted: true,
    });
  });
});
