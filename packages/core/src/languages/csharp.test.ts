// Tests C# token safety and the fake and real CSharpier subprocess boundary.
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProcessResult, ProcessRunner } from "../process.js";
import { toLf } from "../text.js";
import { findAdapterForPath } from "./adapter.js";
import {
  createCSharpAdapter,
  csharpAdapter,
  formatWithCSharpier,
} from "./csharp.js";
import { defaultAdapters } from "./index.js";

const csharpierInstalled = spawnSync("csharpier", ["--version"]).status === 0;

function fakeRunner(result: ProcessResult) {
  const calls: { command: string; args: readonly string[]; stdin: string }[] =
    [];
  const run: ProcessRunner = (command, args, stdin) => {
    calls.push({ command, args, stdin });
    return Promise.resolve(result);
  };
  return { run, calls };
}

describe("C# adapter", () => {
  it("registers .cs files and ordinary line comments", () => {
    expect(findAdapterForPath("src/Program.CS", defaultAdapters)).toBe(
      csharpAdapter,
    );
    expect(csharpAdapter.id).toBe("csharp");
    expect(csharpAdapter.extensions).toEqual([".cs"]);
    expect(csharpAdapter.lineComment).toBe("//");
  });

  it("excludes line, block and XML doc comments and inter-token whitespace", async () => {
    const plain = "class C { int Value(int x) { return x * 2; } }";
    const commented =
      "// note\n/** block */\n/// <summary>XML docs</summary>\nclass C { int Value( int x ) { /* value */ return x * 2; // result\n} }";
    const tokens = await csharpAdapter.tokens(plain);
    expect(tokens).toContain("Value");
    expect(tokens.filter((token) => token.startsWith("<<"))).toEqual([]);
    expect(await csharpAdapter.tokens(commented)).toEqual(tokens);
  });

  it.each([
    ["identifier", "other * 2"],
    ["operator", "value + 2"],
    ["literal", "value * 3"],
  ])("detects a changed %s", async (_kind, expression) => {
    const source = (value: string) =>
      `class C { int F(int value) => ${value}; }`;
    expect(await csharpAdapter.tokens(source(expression))).not.toEqual(
      await csharpAdapter.tokens(source("value * 2")),
    );
  });

  it("reports syntax errors in the token stream", async () => {
    expect(await csharpAdapter.tokens("class C { void Broken( {")).toContain(
      "<<syntax-error>>",
    );
  });

  it("exposes code after NEXT LINE without conflating NEXT LINE and LF in strings", async () => {
    const code = "class C {}";
    expect(
      await csharpAdapter.tokens(`// note\u0085class Injected {}\n${code}`),
    ).toContain("Injected");
    expect(
      await csharpAdapter.tokens(`// note\u0085class Injected {}\n${code}`),
    ).not.toEqual(await csharpAdapter.tokens(code));
    const source = (value: string) =>
      `class C { string Value = @"first${value}last"; }`;
    expect(await csharpAdapter.tokens(source("\u0085"))).not.toEqual(
      await csharpAdapter.tokens(source("\n")),
    );
  });
});

describe("formatWithCSharpier", () => {
  it.each([undefined, "src/Folder With Spaces/Program.cs"])(
    "passes stdin and preserves stdout, using the source path for settings (%s)",
    async (path) => {
      const { run, calls } = fakeRunner({
        kind: "completed",
        exitCode: 0,
        stdout: "class C { }\n",
        stderr: "",
      });
      expect(await formatWithCSharpier("class C{}", path, run)).toEqual({
        code: "class C { }\n",
        formatted: true,
      });
      expect(calls).toEqual([
        {
          command: "csharpier",
          args: [
            "format",
            "--write-stdout",
            ...(path === undefined ? [] : ["--stdin-path", path]),
          ],
          stdin: "class C{}",
        },
      ]);
    },
  );

  it("returns unchanged code when CSharpier is missing", async () => {
    const { run } = fakeRunner({ kind: "not-found" });
    expect(await formatWithCSharpier("class C{}", undefined, run)).toEqual({
      code: "class C{}",
      formatted: false,
    });
  });

  it("preserves nonempty input when an ignored stdin path produces empty stdout", async () => {
    const { run } = fakeRunner({
      kind: "completed",
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    expect(await formatWithCSharpier("class C{}", "ignored.cs", run)).toEqual({
      code: "class C{}",
      formatted: false,
    });
  });

  it("accepts empty output when the input is whitespace only", async () => {
    const { run } = fakeRunner({
      kind: "completed",
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    expect(await formatWithCSharpier(" \n", undefined, run)).toEqual({
      code: "",
      formatted: true,
    });
  });

  it("throws the first meaningful stderr line on a nonzero exit", async () => {
    const { run } = fakeRunner({
      kind: "completed",
      exitCode: 1,
      stdout: "",
      stderr:
        "\r\n  Error input.cs - Was not formatted due to syntax errors.\r\nmore detail",
    });
    await expect(
      formatWithCSharpier("class C{", undefined, run),
    ).rejects.toThrow(
      "csharpier failed (exit code 1): Error input.cs - Was not formatted due to syntax errors.",
    );
  });

  it("uses the injected runner through adapter.format", async () => {
    const { run, calls } = fakeRunner({ kind: "not-found" });
    await createCSharpAdapter({ runProcess: run }).format(
      "class C{}",
      "src/C.cs",
    );
    expect(calls).toEqual([
      {
        command: "csharpier",
        args: ["format", "--write-stdout", "--stdin-path", "src/C.cs"],
        stdin: "class C{}",
      },
    ]);
  });

  it.skipIf(!csharpierInstalled)(
    "formats with real CSharpier and rejects syntax errors",
    async () => {
      const result = await csharpAdapter.format("class C{int Value()=>2;}");
      expect(result.formatted).toBe(true);
      expect(toLf(result.code)).toMatch(
        /class C\n\{\n +int Value\(\) => 2;\n\}\n$/,
      );
      await expect(
        csharpAdapter.format("class C { void Broken( {"),
      ).rejects.toThrow(/csharpier failed \(exit code 1\): .*syntax errors/);
    },
  );

  it.skipIf(!csharpierInstalled)(
    "preserves code ignored by a real .csharpierignore",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "whycode-csharpier-"));
      try {
        await writeFile(join(directory, ".csharpierignore"), "ignored.cs\n");
        expect(
          await csharpAdapter.format(
            "class C{}",
            join(directory, "ignored.cs"),
          ),
        ).toEqual({ code: "class C{}", formatted: false });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!csharpierInstalled).each([
    [".csharpierrc", '{"indentSize": 3}'],
    [".csharpierrc.json", '{"indentSize": 3}'],
    [".csharpierrc.yaml", "indentSize: 3\n"],
    [
      ".editorconfig",
      "root = true\n[*.cs]\nindent_style = space\nindent_size = 3\n",
    ],
  ])(
    "discovers real ancestor %s settings from a stdin path",
    async (name, settings) => {
      const directory = await mkdtemp(join(tmpdir(), "whycode-csharpier-"));
      try {
        const nested = join(directory, "src", "nested");
        await mkdir(nested, { recursive: true });
        await writeFile(join(directory, name), settings);
        const result = await csharpAdapter.format(
          "class C{int Value()=>2;}",
          join(nested, "C.cs"),
        );
        expect(toLf(result.code)).toBe("class C\n{\n   int Value() => 2;\n}\n");
        expect(result.formatted).toBe(true);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
