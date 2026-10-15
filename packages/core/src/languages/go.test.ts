// Tests Go token safety and the gofmt subprocess boundary without requiring Go.
// A real formatter smoke test runs only when gofmt is already on PATH.
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { ProcessResult, ProcessRunner } from "../process.js";
import { findAdapterForPath } from "./adapter.js";
import { createGoAdapter, formatWithGofmt, goAdapter } from "./go.js";
import { defaultAdapters } from "./index.js";

const gofmtInstalled = spawnSync("gofmt", ["-h"]).error === undefined;

function fakeRunner(result: ProcessResult) {
  const calls: { command: string; args: readonly string[]; stdin: string }[] =
    [];
  const run: ProcessRunner = (command, args, stdin) => {
    calls.push({ command, args, stdin });
    return Promise.resolve(result);
  };
  return { run, calls };
}

describe("Go adapter", () => {
  it("registers .go files with Go line comments", () => {
    expect(findAdapterForPath("src/main.go", defaultAdapters)).toBe(goAdapter);
    expect(goAdapter.id).toBe("go");
    expect(goAdapter.extensions).toEqual([".go"]);
    expect(goAdapter.lineComment).toBe("//");
  });

  it("ignores line, block and doc comments and inter-token whitespace", async () => {
    const plain = "package p\nfunc identity(x int) int { return x }\n";
    const commented =
      "// Package p explains identity.\npackage p\n/* Identity returns x. */\nfunc identity( x int ) int { /* value */ return x // result\n}\n";
    expect(await goAdapter.tokens(commented)).toEqual(
      await goAdapter.tokens(plain),
    );
    expect(await goAdapter.tokens(plain)).toContain("identity");
  });

  it.each([
    ["identifier", "price * count", "cost * count"],
    ["operator", "price * count", "price + count"],
    ["literal", "price * 2", "price * 3"],
  ])("notices a changed %s", async (_name, before, after) => {
    const source = (expression: string) =>
      `package p\nfunc total(price, count int) int { return ${expression} }\n`;
    expect(await goAdapter.tokens(source(after))).not.toEqual(
      await goAdapter.tokens(source(before)),
    );
  });

  it("reports syntax errors in the token stream", async () => {
    expect(await goAdapter.tokens("package p\nfunc broken( {\n")).toContain(
      "<<syntax-error>>",
    );
  });
});

describe("formatWithGofmt", () => {
  it("passes code on stdin with no arguments or config lookup", async () => {
    const { run, calls } = fakeRunner({
      kind: "completed",
      exitCode: 0,
      stdout: "package p\n\nvar x = 1\n",
      stderr: "",
    });
    expect(await formatWithGofmt("package p\nvar x=1", run)).toEqual({
      code: "package p\n\nvar x = 1\n",
      formatted: true,
    });
    expect(calls).toEqual([
      { command: "gofmt", args: [], stdin: "package p\nvar x=1" },
    ]);
  });

  it("returns unchanged code when gofmt is missing", async () => {
    const { run } = fakeRunner({ kind: "not-found" });
    expect(await formatWithGofmt("package p\nvar x=1", run)).toEqual({
      code: "package p\nvar x=1",
      formatted: false,
    });
  });

  it("throws with only the first stderr line on failure", async () => {
    const { run } = fakeRunner({
      kind: "completed",
      exitCode: 2,
      stdout: "",
      stderr: "<standard input>:2:9: expected operand\r\nmore detail",
    });
    await expect(formatWithGofmt("package p\nvar x =", run)).rejects.toThrow(
      "gofmt failed (exit code 2): <standard input>:2:9: expected operand",
    );
  });

  it("uses the injected runner through adapter.format and ignores file paths", async () => {
    const { run, calls } = fakeRunner({ kind: "not-found" });
    expect(
      await createGoAdapter({ runProcess: run }).format(
        "package p\n",
        "src/p.go",
      ),
    ).toEqual({ code: "package p\n", formatted: false });
    expect(calls).toEqual([
      { command: "gofmt", args: [], stdin: "package p\n" },
    ]);
  });

  it.skipIf(!gofmtInstalled)("formats with the real gofmt binary", async () => {
    expect(await goAdapter.format("package p\nfunc f(){println(1)}\n")).toEqual(
      { code: "package p\n\nfunc f() { println(1) }\n", formatted: true },
    );
  });
});

describe("cgo preamble tokens", () => {
  it.each([
    [
      "line comments",
      '// #include <stdlib.h>\n// typedef int number;\nimport "C"\n',
    ],
    ["block comments", '/*\n#include <stdlib.h>\n*/\nimport "C"\n'],
    [
      "mixed comment groups",
      '// C declarations.\n/* typedef int number; */\nimport "C"\n',
    ],
    [
      "grouped import spec",
      'import (\n// typedef int number;\n"C"\n"fmt"\n)\n',
    ],
    [
      "single grouped import declaration",
      '// typedef int number;\nimport (\n"C"\n)\n',
    ],
  ])("protects %s, including additions at both ends", async (_name, body) => {
    const code = `package p\n\n${body}`;
    const tokens = await goAdapter.tokens(code);
    expect(tokens).toContain("<<cgo-preamble>>");
    const firstComment = code.indexOf("/", code.indexOf("package"));
    const target = body.includes("import (\n//") ? '"C"' : "import";
    const targetIndex = code.lastIndexOf(target);
    const above =
      code.slice(0, firstComment) +
      "// Added above.\n" +
      code.slice(firstComment);
    const below =
      code.slice(0, targetIndex) +
      "// Added below.\n" +
      code.slice(targetIndex);
    expect(await goAdapter.tokens(above)).not.toEqual(tokens);
    expect(await goAdapter.tokens(below)).not.toEqual(tokens);
    expect(
      await goAdapter.tokens(
        code.replace("number", "different").replace("stdlib", "stdio"),
      ),
    ).not.toEqual(tokens);
  });

  it("detects creating a preamble where there was none", async () => {
    const code = 'package p\n\nimport "C"\n';
    expect(
      await goAdapter.tokens(
        code.replace("import", "// New preamble.\nimport"),
      ),
    ).not.toEqual(await goAdapter.tokens(code));
  });

  it("ignores comments separated from the preamble by a blank line", async () => {
    const code = 'package p\n\n/* typedef int number; */\nimport "C"\n';
    expect(
      await goAdapter.tokens(code.replace("/*", "// Safe explanation.\n\n/*")),
    ).toEqual(await goAdapter.tokens(code));
  });

  it("ignores ordinary imports and import-looking text inside strings", async () => {
    const code =
      'package p\nimport "fmt"\nvar example = `// preamble\nimport "C"`\n';
    expect(
      await goAdapter.tokens(
        code.replace('import "fmt"', '// Standard library.\nimport "fmt"'),
      ),
    ).toEqual(await goAdapter.tokens(code));
    expect(await goAdapter.tokens(code)).not.toContain("<<cgo-preamble>>");
  });

  it("ends a comment group at a whitespace-only blank line with CRLF", async () => {
    const code =
      'package p\r\n\r\n// ordinary\r\n \t\r\n// typedef int number;\r\nimport "C"\r\n';
    expect(
      await goAdapter.tokens(code.replace("ordinary", "different")),
    ).toEqual(await goAdapter.tokens(code));
  });
});
