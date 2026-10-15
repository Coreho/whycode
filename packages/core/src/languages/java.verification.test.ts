// Exercises Java fixtures and hostile comment text through the real pipeline.
// Formatter-independent safety tests are paired with gated native formatter runs.
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AIRequest } from "../ai/provider.js";
import { resolveConfig } from "../config.js";
import { processFile } from "../pipeline.js";
import { commentPlanReply, FakeAIProvider } from "../testing/fake-provider.js";
import {
  commentAboveEveryMatch,
  commentAboveFirstMatch,
} from "../testing/scripted-replies.js";
import type { LanguageAdapter } from "./adapter.js";
import { defaultAdapters } from "./index.js";
import { createJavaAdapter, javaAdapter } from "./java.js";

const formatterInstalled =
  spawnSync("google-java-format", ["--version"]).status === 0;
const FIXTURES = join(import.meta.dirname, "..", "..", "fixtures", "java");
const PROBE = "Probe comment.";
const DEFINITION =
  /^\s*(?:(?:class|record)\b|(?:OrderProcessor|double\s+\w+|List<String>\s+\w+|static\s+<T>\s+Map<String,\s*List<T>>\s+\w+)\s*\()/;
const unformattedJava = createJavaAdapter({
  runProcess: () => Promise.resolve({ kind: "not-found" }),
});

async function fixture(name = "verification.java") {
  return readFile(join(FIXTURES, name), "utf8");
}

async function runCode(
  code: string,
  reply: (request: AIRequest) => string,
  adapters: readonly LanguageAdapter[] = [unformattedJava],
) {
  return processFile(
    { path: join(FIXTURES, "verification.java"), code },
    resolveConfig(),
    { provider: new FakeAIProvider(reply), adapters },
  );
}

async function runFixture(
  target: RegExp,
  text = PROBE,
  adapter = unformattedJava,
) {
  return runCode(await fixture(), commentAboveFirstMatch(target, text), [
    adapter,
  ]);
}

async function expectClean(code: string) {
  const tokens = await javaAdapter.tokens(code);
  expect(tokens.length).toBeGreaterThan(0);
  expect(tokens.filter((token) => token.startsWith("<<"))).toEqual([]);
}

describe("Java fixtures", () => {
  it.each(["messy.java", "verification.java"])(
    "%s parses without errors",
    async (name) => {
      await expectClean(await fixture(name));
    },
  );

  async function expectMessyPipeline(
    adapters: readonly LanguageAdapter[],
    formatted: boolean,
  ) {
    const result = await runCode(
      await fixture("messy.java"),
      commentAboveEveryMatch(DEFINITION, PROBE),
      adapters,
    );
    expect(result.languageId).toBe("java");
    expect(result.mode).toBe("full");
    expect(result.status).toBe("changed");
    expect(result.verification).toBe("passed");
    expect(result.formatted).toBe(formatted);
    // Three types, one constructor and four methods, all on their own lines.
    expect(result.outputCode.split(PROBE)).toHaveLength(9);
    await expectClean(result.outputCode);
    expect(result.warnings).toEqual(
      formatted
        ? []
        : ["No formatter available for java; formatting was skipped."],
    );
  }

  it("keeps comments above every type and method without the formatter", async () => {
    await expectMessyPipeline([unformattedJava], false);
  });

  it.skipIf(!formatterInstalled)(
    "keeps comments above every type and method with the real formatter and registry",
    async () => {
      await expectMessyPipeline(defaultAdapters, true);
    },
  );

  it("leaves the verification fixture unchanged with an empty plan", async () => {
    const code = await fixture();
    const result = await runCode(code, () => commentPlanReply({}));
    expect(result.verification).toBe("passed");
    expect(result.outputCode).toBe(code);
  });
});

const VALID_TARGETS: [string, RegExp][] = [
  ["annotation declaration", /^@interface Tags/],
  ["annotation array value", /^\s*"verification",/],
  ["annotated class", /^class Verification/],
  ["generic wildcards", /^\s*static int calculate/],
  ["lambda", /^\s*Function<Entry, String> label/],
  ["method reference", /^\s*Function<String, String> normalize/],
  ["switch expression", /^\s*return switch/],
  ["arrow arm", /^\s*case 1 -> total;/],
  ["yield", /^\s*yield total \+ 1;/],
  ["record", /^record Entry/],
  ["enum trailing comma", /^\s*SAFE,/],
  ["enum constant body", /^\s*DOUBLE \{/],
  ["anonymous class", /^\s*Runnable reporter/],
  ["labeled loop", /^\s*collect:/],
  ["labeled break", /^\s*break collect;/],
  ["labeled continue", /^\s*continue collect;/],
  ["array initializer", /^\s*2,$/],
  ["escaped string", /^\s*static final String ESCAPED/],
];

describe.each([
  ["without formatter", unformattedJava, true],
  ["with real formatter", javaAdapter, formatterInstalled],
] as const)("Java comment placement %s", (_name, adapter, enabled) => {
  it.skipIf(!enabled).each(VALID_TARGETS)(
    "keeps a comment above %s",
    async (_kind, target) => {
      const result = await runFixture(target, PROBE, adapter);
      expect(result.verification).toBe("passed");
      expect(result.outputCode).toContain(`// ${PROBE}`);
      await expectClean(result.outputCode);
    },
  );

  it
    .skipIf(!enabled)
    .each([/^\s*Customer "Ada"/, /^\s*Keep this text block line/, /^\s*""";/])(
    "discards a comment inside a text block at %s",
    async (target) => {
      const code = await fixture();
      const result = await runFixture(target, PROBE, adapter);
      expect(result.verification).toBe("failed");
      expect(result.outputCode).toBe((await adapter.format(code)).code);
      expect(result.outputCode).not.toContain(PROBE);
      expect(result.warnings.join("\n")).toMatch(
        /tokens changed \(token \d+: expected/,
      );
    },
  );

  it.skipIf(!enabled).each([
    ["/// x", ["// / x"]],
    ["*/ System.exit(1);", ["// */ System.exit(1);"]],
    [
      "First line\nSystem.exit(1);\r\nThird line\u2028Fourth line\u2029Last line",
      [
        "// First line",
        "// System.exit(1);",
        "// Third line",
        "// Fourth line",
        "// Last line",
      ],
    ],
  ])("renders AI text %j as spaced line comments", async (text, expected) => {
    const result = await runFixture(/^class Verification/, text, adapter);
    expect(result.verification).toBe("passed");
    for (const line of expected) expect(result.outputCode).toContain(line);
    await expectClean(result.outputCode);
  });

  it
    .skipIf(!enabled)
    .each([
      String.raw`note \u000a System.exit(1);`,
      String.raw`note \uuuu000A System.exit(1);`,
      String.raw`note \u000d System.exit(1);`,
      String.raw`note \u002a\u002f System.exit(1);`,
      String.raw`even a harmless letter \u0061`,
      String.raw`incomplete escape \u12`,
      String.raw`invalid escape \uZZZZ`,
    ])("discards a newly inserted Unicode escape %s", async (text) => {
    const code =
      "class Example {\n  void run() {\n    int value = 1;\n  }\n}\n";
    const result = await runCode(
      code,
      commentAboveFirstMatch(/^\s*int value/, text),
      [adapter],
    );
    expect(result.verification).toBe("failed");
    expect(result.outputCode).toBe((await adapter.format(code)).code);
    expect(result.outputCode).not.toContain(text);
    expect(result.warnings.join("\n")).toMatch(
      /tokens changed|formatter rejected/,
    );
  });

  it
    .skipIf(!enabled)
    .each([
      String.raw`// existing \u0061`,
      String.raw`/* existing \uuuu0061 */`,
      String.raw`/** existing \u0061 */`,
      String.raw`/* existing \u002a\u002f int injected = 1; /* remainder */`,
    ])(
    "keeps existing escape-bearing comments while adding a safe explanation: %s",
    async (comment) => {
      const code = `class Example {\n  ${comment}\n  int value = 2;\n}\n`;
      const result = await runCode(
        code,
        commentAboveFirstMatch(/^\s*int value/, PROBE),
        [adapter],
      );
      expect(result.verification).toBe("passed");
      expect(result.outputCode).toContain(comment);
      expect(result.outputCode).toContain(`// ${PROBE}`);
    },
  );
});

describe("Java verification detects logic changes", () => {
  it("discards a comment that escapes a block comment opened by encoded delimiters", async () => {
    const code = String.raw`class Example {
  void run() {
    \u002f\u002a
    System.exit(1);
    \u002a\u002f
  }
}
`;
    const result = await runCode(
      code,
      commentAboveFirstMatch(/^\s*System.exit/, "*/ System.exit(2); /*"),
    );
    expect(result.verification).toBe("failed");
    expect(result.outputCode).toBe(code);
  });

  it("discards a comment inside a text block opened by an existing escaped newline", async () => {
    const code = String.raw`class Example {
  // \u000a String value = """
  int content;
  // \u000a """;
}
`;
    const result = await runCode(
      code,
      commentAboveFirstMatch(/^\s*int content/, PROBE),
    );
    expect(result.verification).toBe("failed");
    expect(result.outputCode).toBe(code);
  });

  it("keeps safe comments outside a block comment opened by encoded delimiters", async () => {
    const code = String.raw`class Example {
  \u002f\u002a ignored \u002a\u002f
  int value = 1;
}
`;
    const result = await runCode(
      code,
      commentAboveFirstMatch(/^\s*int value/, PROBE),
    );
    expect(result.verification).toBe("passed");
    expect(result.outputCode).toContain(PROBE);
  });

  it("keeps an existing escaped newline when the formatter is unavailable", async () => {
    const comment = String.raw`// existing \u000a int injected = 1;`;
    const code = `class Example {\n  ${comment}\n  int value = 2;\n}\n`;
    const result = await runCode(
      code,
      commentAboveFirstMatch(/^\s*int value/, PROBE),
    );
    expect(result.verification).toBe("passed");
    expect(result.outputCode).toContain(comment);
    expect(result.outputCode).toContain(PROBE);
  });

  it.skipIf(!formatterInstalled)(
    "reports the formatter's unsupported existing escaped newline",
    async () => {
      const code =
        String.raw`class Example { // existing \u000a int value = 1;` + "\n}\n";
      const result = await runCode(code, () => commentPlanReply({}), [
        javaAdapter,
      ]);
      expect(result.status).toBe("skipped");
      expect(result.outputCode).toBe(code);
      expect(result.skipReason).toMatch(
        /google-java-format failed \(exit code 1\)/,
      );
    },
  );

  it("discards a changed operator and names the differing token", async () => {
    let calls = 0;
    const adapter: LanguageAdapter = {
      ...unformattedJava,
      async format(code) {
        const result = await unformattedJava.format(code);
        if (++calls === 1) return result;
        const mutated = result.code.replace("quantity * 2", "quantity + 2");
        expect(mutated).not.toBe(result.code);
        return { ...result, code: mutated };
      },
    };
    const result = await runFixture(/^record Entry/, PROBE, adapter);
    expect(result.verification).toBe("failed");
    expect(result.outputCode).toBe(await fixture());
    expect(result.warnings.join("\n")).toMatch(/expected "\*", found "\+"/);
  });

  it("discards text inserted inside an existing escape-bearing block comment", async () => {
    const code =
      String.raw`/* existing \u0061` +
      "\nmore documentation\n*/\nclass Example {}\n";
    const result = await runCode(
      code,
      commentAboveFirstMatch(/^more documentation/, PROBE),
    );
    expect(result.verification).toBe("failed");
    expect(result.outputCode).toBe(code);
    expect(result.warnings.join("\n")).toMatch(/tokens changed/);
  });
});
