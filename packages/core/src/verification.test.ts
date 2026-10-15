// Proof that the logic-unchanged check holds with the real Python and
// TypeScript adapters. Each case aims a comment (or a simulated logic change)
// at a risky construct in the verification fixtures, then checks the result:
// harmful changes are caught or refused, harmless ones are kept.
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as prettier from "prettier";
import { describe, expect, it } from "vitest";
import type { AIRequest } from "./ai/provider.js";
import { resolveConfig } from "./config.js";
import type { LanguageAdapter } from "./languages/adapter.js";
import { findAdapterForPath } from "./languages/adapter.js";
import { defaultAdapters } from "./languages/index.js";
import { typescriptAdapter } from "./languages/typescript.js";
import type { FileResult } from "./pipeline.js";
import { processFile } from "./pipeline.js";
import { commentPlanReply, FakeAIProvider } from "./testing/fake-provider.js";
import { commentAboveFirstMatch } from "./testing/scripted-replies.js";

const FIXTURES_DIR = join(import.meta.dirname, "..", "fixtures");
const PROBE = "Probe comment.";
const ruffInstalled = spawnSync("ruff", ["--version"]).error === undefined;

interface FixtureCase {
  language: string;
  path: string;
}

const PYTHON: FixtureCase = {
  language: "python",
  path: "python/verification.py",
};
const TYPESCRIPT: FixtureCase = {
  language: "typescript",
  path: "typescript/verification.tsx",
};

async function run(
  fixture: FixtureCase,
  reply: (request: AIRequest) => string,
  adapters: readonly LanguageAdapter[] = defaultAdapters,
): Promise<FileResult> {
  const code = await readFile(join(FIXTURES_DIR, fixture.path), "utf8");
  return processFile(
    { path: fixture.path, code },
    resolveConfig({ format: "always" }),
    {
      provider: new FakeAIProvider(reply),
      adapters,
    },
  );
}

/** The fixture as the formatter leaves it, with no AI comments at all. */
async function formattingOnly(fixture: FixtureCase): Promise<string> {
  return (await run(fixture, () => commentPlanReply({}))).outputCode;
}

/** Every token is real code; marker tokens like "<<syntax-error>>" mean broken code. */
async function parsesCleanly(
  fixture: FixtureCase,
  code: string,
): Promise<boolean> {
  const adapter = findAdapterForPath(fixture.path, defaultAdapters);
  if (adapter === undefined) throw new Error(`No adapter for ${fixture.path}`);
  const tokens = await adapter.tokens(code);
  return !tokens.some((token) => token.startsWith("<<"));
}

/**
 * Wraps an adapter so its second format call (the re-format after comments
 * are inserted) also applies `mutate`, simulating a logic change slipping in.
 * Throws if the mutation finds nothing to change, so tests can't pass vacuously.
 */
function withLogicChange(
  adapter: LanguageAdapter,
  mutate: (code: string) => string,
): LanguageAdapter {
  let formatCalls = 0;
  return {
    ...adapter,
    async format(code, filePath) {
      formatCalls += 1;
      const result = await adapter.format(code, filePath);
      if (formatCalls === 1) return result;
      const mutated = mutate(result.code);
      if (mutated === result.code)
        throw new Error("Logic change did not apply.");
      return { ...result, code: mutated };
    },
  };
}

/**
 * Wraps an adapter so its re-format (after comments are inserted) runs
 * Prettier at a narrow width, forcing lists that fit before to split.
 */
function withNarrowReformat(adapter: LanguageAdapter): LanguageAdapter {
  let formatCalls = 0;
  return {
    ...adapter,
    async format(code, filePath) {
      formatCalls += 1;
      if (formatCalls === 1) return adapter.format(code, filePath);
      const narrow = await prettier.format(code, {
        parser: "typescript",
        printWidth: 40,
      });
      return { code: narrow, formatted: true };
    },
  };
}

function adapterFor(fixture: FixtureCase): LanguageAdapter {
  const adapter = findAdapterForPath(fixture.path, defaultAdapters);
  if (adapter === undefined) throw new Error(`No adapter for ${fixture.path}`);
  return adapter;
}

/** Asserts the AI's changes were thrown away and only formatting survived. */
async function expectDiscarded(fixture: FixtureCase, result: FileResult) {
  expect(result.verification).toBe("failed");
  expect(result.outputCode).toBe(await formattingOnly(fixture));
  expect(result.outputCode).not.toContain(PROBE);
}

describe("comments inside multi-line strings are caught", () => {
  it.each([
    { fixture: PYTHON, target: /^Your order \{order_id\} has shipped\./ },
    { fixture: TYPESCRIPT, target: /^=======$/ },
  ])("$fixture.language", async ({ fixture, target }) => {
    const result = await run(fixture, commentAboveFirstMatch(target, PROBE));
    await expectDiscarded(fixture, result);
    expect(result.warnings.join("\n")).toMatch(
      /tokens changed \(token \d+: expected/,
    );
  });
});

describe("comments after a line continuation are refused", () => {
  it.each([
    { fixture: PYTHON, target: /^across two lines inside a string literal/ },
    {
      fixture: TYPESCRIPT,
      target: /^across two lines inside a string literal/,
    },
  ])(
    "$fixture.language: backslash continuation inside a string",
    async ({ fixture, target }) => {
      const result = await run(fixture, commentAboveFirstMatch(target, PROBE));
      expect(result.outputCode).not.toContain(PROBE);
      expect(result.outputCode).toBe(await formattingOnly(fixture));
      expect(result.warnings.join("\n")).toMatch(
        /the line before it ends with a backslash line continuation/,
      );
    },
  );
});

describe("comment text cannot inject code", () => {
  const injections = [
    "Explains this.\nprint('injected')",
    "Explains this.\rprint('injected')",
    `Explains this.${String.fromCharCode(0x2028)}print('injected')`,
    "Explains this. */ print('injected')",
  ];

  it.each([
    { fixture: PYTHON, target: /^def summarize/, marker: /^#/ },
    {
      fixture: TYPESCRIPT,
      target: /^export function OrderSummary/,
      marker: /^\/\//,
    },
  ])("$fixture.language", async ({ fixture, target, marker }) => {
    for (const text of injections) {
      const result = await run(fixture, commentAboveFirstMatch(target, text));
      expect(result.verification).toBe("passed");
      expect(await parsesCleanly(fixture, result.outputCode)).toBe(true);
      // Every line holding the injected code is a comment line.
      const injectedLines = result.outputCode
        .split("\n")
        .filter((line) => line.includes("print('injected')"));
      expect(injectedLines.length).toBeGreaterThan(0);
      for (const line of injectedLines)
        expect(line.trimStart()).toMatch(marker);
    }
  });
});

describe("JSX: text is caught, code positions are kept", () => {
  it("catches a comment that lands in JSX text", async () => {
    const result = await run(
      TYPESCRIPT,
      commentAboveFirstMatch(/^\s*Your order contains/, PROBE),
    );
    await expectDiscarded(TYPESCRIPT, result);
  });

  it.each([
    { place: "between JSX attributes", target: /^\s*data-expanded=/ },
    { place: "inside a JSX expression", target: /^\s*<li key=/ },
  ])("keeps a valid comment $place", async ({ target }) => {
    const result = await run(TYPESCRIPT, commentAboveFirstMatch(target, PROBE));
    expect(result.verification).toBe("passed");
    expect(result.outputCode).toContain(`// ${PROBE}`);
    expect(await parsesCleanly(TYPESCRIPT, result.outputCode)).toBe(true);
  });
});

describe("trailing commas a formatter adds when it splits a list are not logic changes", () => {
  describe.skipIf(!ruffInstalled)("Ruff", () => {
    it.each([
      { place: "above", target: /^\s+first_argument_value, second_argument/ },
      { place: "below", target: /^ {4}\)$/ },
    ])(
      "keeps a comment $place arguments Ruff had hugged on one line",
      async ({ target }) => {
        const result = await run(PYTHON, commentAboveFirstMatch(target, PROBE));
        expect(result.verification).toBe("passed");
        expect(result.outputCode).toContain(`# ${PROBE}`);
        // Ruff really did split the arguments and add a trailing comma.
        expect(result.outputCode).toContain("        scale,\n");
        expect(await parsesCleanly(PYTHON, result.outputCode)).toBe(true);
      },
    );
  });

  // Whole-line comments rarely make Prettier split a list, since Prettier
  // already gives each item its own line whenever a list breaks. So the
  // re-format here runs at a narrower width to force the split.
  it("keeps a comment when Prettier splits a call, an array and an object", async () => {
    const code = [
      "export const totals = summarize(firstValue, secondValue);",
      "export const names = [firstName, secondName];",
      "export const options = { retries: 3, timeout: 1000 };",
      "",
    ].join("\n");
    const result = await processFile(
      { path: "split.ts", code },
      resolveConfig({ format: "always" }),
      {
        provider: new FakeAIProvider(
          commentAboveFirstMatch(/^export const totals/, PROBE),
        ),
        adapters: [withNarrowReformat(typescriptAdapter)],
      },
    );
    expect(result.verification).toBe("passed");
    expect(result.outputCode).toContain(`// ${PROBE}`);
    for (const split of ["secondValue,\n);", "secondName,\n];", "1000,\n};"]) {
      expect(result.outputCode).toContain(split);
    }
  });
});

describe("simulated logic changes are reported with the first differing token", () => {
  const harmlessComment = (fixture: FixtureCase) =>
    commentAboveFirstMatch(
      fixture === PYTHON ? /^def summarize/ : /^export function/,
      PROBE,
    );

  interface LogicChange {
    change: string;
    fixture: FixtureCase;
    mutate: (code: string) => string;
    message: RegExp;
  }

  const cases: LogicChange[] = [
    {
      change: "changed operator",
      fixture: PYTHON,
      mutate: (code) => code.replace("len(name) * 2", "len(name) + 2"),
      message: /expected "\*", found "\+"/,
    },
    {
      change: "renamed identifier",
      fixture: PYTHON,
      mutate: (code) => code.replace("    average = sum", "    mean = sum"),
      message: /expected "average", found "mean"/,
    },
    {
      change: "removed statement",
      fixture: PYTHON,
      mutate: (code) => code.replace("    count = len(values)\n", ""),
      message: /expected "count", found "average"/,
    },
    {
      change: "value turned into a one-item tuple",
      fixture: PYTHON,
      mutate: (code) => code.replace("[0] + 1)", "[0] + 1,)"),
      message: /expected "\)", found ","/,
    },
    {
      change: "index turned into a tuple index",
      fixture: PYTHON,
      mutate: (code) => code.replace("value[0]", "value[0,]"),
      message: /expected "\]", found ","/,
    },
    {
      change: "renamed argument beside a trailing comma",
      fixture: PYTHON,
      mutate: (code) => code.replace(/\bscale,?(\s*\n\s*\))/, "other_scale,$1"),
      message: /expected "scale", found "other_scale"/,
    },
    {
      change: "changed operator",
      fixture: TYPESCRIPT,
      mutate: (code) => code.replace("item.price * 1.08", "item.price / 1.08"),
      message: /expected "\*", found "\/"/,
    },
    {
      change: "renamed identifier",
      fixture: TYPESCRIPT,
      mutate: (code) => code.replace("const average =", "const mean ="),
      message: /expected "average", found "mean"/,
    },
    {
      change: "removed statement",
      fixture: TYPESCRIPT,
      mutate: (code) =>
        code.replace("  const average = total / items.length;\n", ""),
      message: /expected "const", found "return"/,
    },
  ];

  it.each(cases)(
    "$change in $fixture.language",
    async ({ fixture, mutate, message }) => {
      const adapters = [withLogicChange(adapterFor(fixture), mutate)];
      const result = await run(fixture, harmlessComment(fixture), adapters);
      await expectDiscarded(fixture, result);
      expect(result.warnings.join("\n")).toMatch(message);
    },
  );
});
