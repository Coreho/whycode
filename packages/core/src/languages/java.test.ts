// Tests Java verification tokens and the fake and real formatter boundaries.
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { ProcessResult, ProcessRunner } from "../process.js";
import { toLf } from "../text.js";
import { findAdapterForPath } from "./adapter.js";
import { defaultAdapters } from "./index.js";
import {
  createJavaAdapter,
  formatWithGoogleJavaFormat,
  javaAdapter,
} from "./java.js";

const formatterInstalled =
  spawnSync("google-java-format", ["--version"]).status === 0;
const FORMAT_ARGS = [
  "--skip-sorting-imports",
  "--skip-removing-unused-imports",
  "--skip-reflowing-long-strings",
  "--skip-javadoc-formatting",
  "--skip-reordering-modifiers",
  "-",
];

function fakeRunner(result: ProcessResult) {
  const calls: { command: string; args: readonly string[]; stdin: string }[] =
    [];
  const run: ProcessRunner = (command, args, stdin) => {
    calls.push({ command, args, stdin });
    return Promise.resolve(result);
  };
  return { run, calls };
}

describe("Java adapter", () => {
  it("registers .java files with Java line comments", () => {
    expect(findAdapterForPath("src/Main.JAVA", defaultAdapters)).toBe(
      javaAdapter,
    );
    expect(javaAdapter.id).toBe("java");
    expect(javaAdapter.extensions).toEqual([".java"]);
    expect(javaAdapter.lineComment).toBe("//");
  });

  it("excludes line, block and Javadoc comments and inter-token whitespace", async () => {
    const plain = "class Example { int value() { return 2; } }";
    const commented =
      "// Header\n/** Documentation. */\nclass Example { /* note */ int value( ) { return 2; // result\n} }";
    const tokens = await javaAdapter.tokens(plain);
    expect(tokens).toContain("value");
    expect(await javaAdapter.tokens(commented)).toEqual(tokens);
  });

  it.each([
    ["identifier", "int other() { return 2 * 3; }"],
    ["operator", "int value() { return 2 + 3; }"],
    ["literal", "int value() { return 2 * 4; }"],
  ])("detects a changed %s", async (_name, method) => {
    expect(await javaAdapter.tokens(`class Example { ${method} }`)).not.toEqual(
      await javaAdapter.tokens(
        "class Example { int value() { return 2 * 3; } }",
      ),
    );
  });

  it("marks malformed Java in the token stream", async () => {
    expect(await javaAdapter.tokens("class Broken { void run( { }")).toContain(
      "<<syntax-error>>",
    );
  });

  it.each([
    String.raw`// note \u000a System.exit(1);`,
    String.raw`// note \uuuu000A System.exit(1);`,
    String.raw`/* note \u002a\u002f */`,
    String.raw`/** letter \u0061 */`,
  ])("preserves the full escape-bearing comment %s", async (comment) => {
    const code = `${comment}\nclass Example {}`;
    const tokens = await javaAdapter.tokens(code);
    expect(tokens.slice(-2)).toEqual([
      "<<unicode-escape-in-comment>>",
      comment,
    ]);
    expect(await javaAdapter.tokens(`// ordinary\n${code}`)).toEqual(tokens);
    expect(
      await javaAdapter.tokens(
        code.replace("note", "changed").replace("letter", "changed"),
      ),
    ).not.toEqual(tokens);
    expect(await javaAdapter.tokens("class Example {}")).not.toEqual(tokens);
  });

  it.each([String.raw`// incomplete \u12`, String.raw`// invalid \uZZZZ`])(
    "preserves malformed escape candidates that javac rejects: %s",
    async (comment) => {
      const tokens = await javaAdapter.tokens(`${comment}\nclass Example {}`);
      expect(tokens.slice(-2)).toEqual([
        "<<unicode-escape-in-comment>>",
        comment,
      ]);
    },
  );

  it("does not mistake string escapes for sensitive comments", async () => {
    const code = String.raw`class Example { String value = "\u0061"; }`;
    const tokens = await javaAdapter.tokens(code);
    expect(await javaAdapter.tokens(`// ordinary comment\n${code}`)).toEqual(
      tokens,
    );
    expect(tokens).not.toContain("<<unicode-escape-in-comment>>");
  });

  it.each([
    [String.raw`"\u0061"`, '"a"'],
    [String.raw`"\uuuu0061"`, '"a"'],
    [String.raw`"\\u0061"`, String.raw`"\\u0061"`],
    [String.raw`"\\\u006e"`, String.raw`"\\n"`],
    [String.raw`"\u005c\u005c\u006e"`, String.raw`"\\n"`],
    [String.raw`"\u005c\u006e"`, String.raw`"\n"`],
    [String.raw`"\u005c\u005cu006e"`, String.raw`"\\u006e"`],
    [String.raw`"\u005cu006e"`, String.raw`"\u006e"`],
    [String.raw`"\u005c\\u006e"`, String.raw`"\\n"`],
  ])(
    "checks Unicode translation eligibility without recursive decoding: %s",
    async (literal, decodedLiteral) => {
      const source = (value: string) =>
        `class Example { String value = ${value}; }`;
      const tokens = await javaAdapter.tokens(source(literal));
      const marker = tokens.indexOf("<<unicode-decoded-tokens>>");
      if (literal === decodedLiteral) {
        expect(marker).toBe(-1);
      } else {
        expect(marker).toBeGreaterThan(0);
        // The expected source may itself contain escapes; take only its raw view.
        const expected = await javaAdapter.tokens(source(decodedLiteral));
        const expectedMarker = expected.indexOf("<<unicode-decoded-tokens>>");
        expect(tokens.slice(marker + 1)).toEqual(
          expectedMarker < 0 ? expected : expected.slice(0, expectedMarker),
        );
      }
    },
  );
});

describe("formatWithGoogleJavaFormat", () => {
  it("passes stdin and preserves stdout while disabling token and Javadoc rewrites", async () => {
    const { run, calls } = fakeRunner({
      kind: "completed",
      exitCode: 0,
      stdout: "class Example {}\n",
      stderr: "",
    });
    expect(await formatWithGoogleJavaFormat("class Example{}", run)).toEqual({
      code: "class Example {}\n",
      formatted: true,
    });
    expect(calls).toEqual([
      {
        command: "google-java-format",
        args: FORMAT_ARGS,
        stdin: "class Example{}",
      },
    ]);
  });

  it("returns unchanged code when the formatter is missing", async () => {
    const { run } = fakeRunner({ kind: "not-found" });
    expect(await formatWithGoogleJavaFormat("class Example{}", run)).toEqual({
      code: "class Example{}",
      formatted: false,
    });
  });

  it("throws the first meaningful stderr line on failure", async () => {
    const { run } = fakeRunner({
      kind: "completed",
      exitCode: 1,
      stdout: "",
      stderr:
        "\r\n  <stdin>:1:26: error: illegal start of type\r\nsource and caret",
    });
    await expect(formatWithGoogleJavaFormat("broken", run)).rejects.toThrow(
      "google-java-format failed (exit code 1): <stdin>:1:26: error: illegal start of type",
    );
  });

  it("uses the injected runner through adapter.format without project config", async () => {
    const { run, calls } = fakeRunner({ kind: "not-found" });
    expect(
      await createJavaAdapter({ runProcess: run }).format(
        "class Example{}",
        "src/Example.java",
      ),
    ).toEqual({ code: "class Example{}", formatted: false });
    expect(calls).toEqual([
      {
        command: "google-java-format",
        args: FORMAT_ARGS,
        stdin: "class Example{}",
      },
    ]);
  });

  it.skipIf(!formatterInstalled)("formats with the real binary", async () => {
    const result = await javaAdapter.format(
      "class Example{int value(){return 2;}}",
    );
    expect({ ...result, code: toLf(result.code) }).toEqual({
      code: "class Example {\n  int value() {\n    return 2;\n  }\n}\n",
      formatted: true,
    });
  });

  it.skipIf(!formatterInstalled)(
    "reports the real syntax error and exit code",
    async () => {
      await expect(
        javaAdapter.format("class Broken { void run( { }\n"),
      ).rejects.toThrow(
        "google-java-format failed (exit code 1): <stdin>:1:26: error: illegal start of type",
      );
    },
  );

  it.skipIf(!formatterInstalled)(
    "preserves imports, long literals, modifier order and existing Javadoc",
    async () => {
      const code =
        'import java.util.Set;\nimport java.util.List;\n/** Kept   documentation. */\nfinal public class Example { String value = "' +
        "a".repeat(120) +
        '"; }\n';
      const formatted = await javaAdapter.format(code);
      expect(formatted.formatted).toBe(true);
      expect(formatted.code).toContain("/** Kept   documentation. */");
      expect(await javaAdapter.tokens(formatted.code)).toEqual(
        await javaAdapter.tokens(code),
      );
    },
  );
});
