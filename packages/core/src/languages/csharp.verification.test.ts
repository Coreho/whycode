// Exercises C# fixtures through the real pipeline, including risky strings,
// preprocessor lines and AI text that must remain ordinary line comments.
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
import { toLf } from "../text.js";
import type { LanguageAdapter } from "./adapter.js";
import { createCSharpAdapter, csharpAdapter } from "./csharp.js";

const csharpierInstalled = spawnSync("csharpier", ["--version"]).status === 0;
const FIXTURES = join(import.meta.dirname, "..", "..", "fixtures", "csharp");
const PROBE = "Probe comment.";
// All public types and methods in messy.cs start on their own line.
const DEFINITION =
  /^\s*public\s+(?:(?:sealed|static)\s+)?(?:class\b|record\b|.*\()/;
const unformattedCSharp = createCSharpAdapter({
  runProcess: () => Promise.resolve({ kind: "not-found" }),
});

async function runCode(
  code: string,
  reply: (request: AIRequest) => string,
  adapter = unformattedCSharp,
  name = "verification.cs",
) {
  return processFile({ path: join(FIXTURES, name), code }, resolveConfig(), {
    provider: new FakeAIProvider(reply),
    adapters: [adapter],
  });
}

async function runFixture(
  target: RegExp,
  adapter = unformattedCSharp,
  text = PROBE,
) {
  const code = await readFile(join(FIXTURES, "verification.cs"), "utf8");
  return runCode(code, commentAboveFirstMatch(target, text), adapter);
}

async function expectClean(code: string) {
  const tokens = await csharpAdapter.tokens(code);
  expect(tokens.length).toBeGreaterThan(0);
  expect(tokens.filter((token) => token.startsWith("<<"))).toEqual([]);
}

describe("C# pipeline fixtures", () => {
  it.each(["messy.cs", "verification.cs"])(
    "%s parses cleanly",
    async (name) => {
      await expectClean(await readFile(join(FIXTURES, name), "utf8"));
    },
  );

  async function expectMessyPipeline(
    adapter: LanguageAdapter,
    formatted: boolean,
  ) {
    const code = await readFile(join(FIXTURES, "messy.cs"), "utf8");
    const result = await runCode(
      code,
      commentAboveEveryMatch(DEFINITION, PROBE),
      adapter,
      "messy.cs",
    );
    expect(result.languageId).toBe("csharp");
    expect(result.mode).toBe("full");
    expect(result.status).toBe("changed");
    expect(result.verification).toBe("passed");
    expect(result.formatted).toBe(formatted);
    await expectClean(result.outputCode);
    const lines = result.outputCode.split("\n");
    const definitions = lines.filter((line) => DEFINITION.test(line));
    expect(definitions).toHaveLength(11);
    for (const [index, line] of lines.entries()) {
      if (DEFINITION.test(line))
        expect(lines[index - 1]?.trim()).toBe(`// ${PROBE}`);
    }
    expect(lines.filter((line) => line.trim() === `// ${PROBE}`)).toHaveLength(
      definitions.length,
    );
    expect(result.warnings).toEqual(
      formatted
        ? []
        : ["No formatter available for csharp; formatting was skipped."],
    );
  }

  it("comments above every type and method pass without CSharpier", async () => {
    await expectMessyPipeline(unformattedCSharp, false);
  });

  it.skipIf(!csharpierInstalled)(
    "comments above every type and method pass with real CSharpier",
    async () => {
      await expectMessyPipeline(csharpAdapter, true);
    },
  );

  it("leaves the verification fixture unchanged with an empty plan", async () => {
    const code = await readFile(join(FIXTURES, "verification.cs"), "utf8");
    const result = await runCode(code, () => commentPlanReply({}));
    expect(result.verification).toBe("passed");
    expect(result.outputCode).toBe(code);
  });
});

for (const [mode, adapter, installed] of [
  ["without CSharpier", unformattedCSharp, true],
  ["with real CSharpier", csharpAdapter, csharpierInstalled],
] as const) {
  describe.skipIf(!installed)(`C# comment safety ${mode}`, () => {
    it.each([
      ["verbatim string", /^verbatim continues/],
      ["interpolated verbatim string", /^interpolated verbatim continues/],
      ["raw string", /^\s*raw continues/],
      ["interpolated raw string", /^\s*interpolated raw continues/],
    ])(
      "discards a comment inside a %s",
      async (_kind, target) => {
        const original = await readFile(
          join(FIXTURES, "verification.cs"),
          "utf8",
        );
        const result = await runFixture(target, adapter);
        expect(result.verification).toBe("failed");
        expect(result.outputCode).not.toContain(PROBE);
        expect(toLf(result.outputCode)).toBe(
          toLf(
            (await adapter.format(original, join(FIXTURES, "verification.cs")))
              .code,
          ),
        );
        expect(result.warnings.join("\n")).toMatch(
          /tokens changed \(token \d+: expected/,
        );
      },
      15_000,
    );

    it.each([
      ["nullable directive", /^#nullable/],
      ["pragma directive", /^#pragma/],
      ["region directive", /^#region/],
      ["end-region directive", /^#endregion/],
      ["if directive", /^\s*#if/],
      ["else directive", /^\s*#else/],
      ["endif directive", /^\s*#endif/],
      ["XML doc lines", /^\/\/\/ <remarks>/],
      ["attribute", /^\[Serializable\]/],
      ["record", /^public record Entry/],
      ["collection initializer", /^\s*new Entry\("Grace"/],
      ["object initializer", /^\s*Count = 5/],
      ["query clause", /^\s*where entry.Count/],
      ["lambda", /^\s*Func<int, int> twice/],
      ["switch arm", /^\s*> 10 =>/],
    ])("keeps a comment above a %s", async (_kind, target) => {
      const result = await runFixture(target, adapter);
      expect(result.verification).toBe("passed");
      expect(result.outputCode).toContain(`// ${PROBE}`);
      await expectClean(result.outputCode);
      const original = await readFile(
        join(FIXTURES, "verification.cs"),
        "utf8",
      );
      const specialLines = (code: string) =>
        code
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => /^(#|\/\/\/)/.test(line));
      expect(specialLines(result.outputCode)).toEqual(specialLines(original));
      expect(result.outputCode).not.toMatch(
        /\/\/ .*#(?:if|else|endif|region|nullable|pragma)/,
      );
    });

    it.each([
      ["/// x", ["/ x"]],
      ["*/ code", ["*/ code"]],
      [
        "first\nsecond\rthird\u2028fourth\u2029fifth",
        ["first", "second", "third", "fourth", "fifth"],
      ],
      [
        String.raw`\u000a public class Injected {}`,
        [String.raw`\u000a public class Injected {}`],
      ],
      ["#if EVIL", ["#if EVIL"]],
    ])("keeps AI text %j inside ordinary // lines", async (text, expected) => {
      const result = await runFixture(
        /^public static class Examples/,
        adapter,
        text,
      );
      expect(result.verification).toBe("passed");
      for (const line of expected)
        expect(result.outputCode).toContain(`// ${line}\n`);
      await expectClean(result.outputCode);
    });
  });
}

describe("C# verification detects logic changes", () => {
  it.each(["", "// Existing NEXT LINE\u0085\n"])(
    "neutralizes code hidden after a C# NEXT LINE character in AI text (prefix %j)",
    async (prefix) => {
      const code = `${prefix}class C {}\n`;
      const result = await runCode(
        code,
        commentAboveFirstMatch(/^class C/, "note\u0085class Injected {}"),
      );
      // Insertion splits on U+0085, so the code lands on its own comment line.
      expect(result.verification).toBe("passed");
      expect(result.outputCode).toContain("// class Injected {}\n");
    },
  );

  it("discards a changed operator and names the differing token", async () => {
    let calls = 0;
    const adapter: LanguageAdapter = {
      ...unformattedCSharp,
      async format(code, path) {
        const result = await unformattedCSharp.format(code, path);
        if (++calls === 1) return result;
        const mutated = result.code.replace("value * 2", "value + 2");
        expect(mutated).not.toBe(result.code);
        return { ...result, code: mutated };
      },
    };
    const result = await runFixture(/^public static class Examples/, adapter);
    expect(result.verification).toBe("failed");
    expect(result.outputCode).toBe(
      await readFile(join(FIXTURES, "verification.cs"), "utf8"),
    );
    expect(result.outputCode).not.toContain(PROBE);
    expect(result.warnings.join("\n")).toMatch(/expected "\*", found "\+"/);
  });
});
