// Proof that the logic-unchanged check holds with the real Python and
// TypeScript adapters. Each case aims a comment (or a simulated logic change)
// at a risky construct in the verification fixtures, then checks the result:
// harmful changes are caught or refused, harmless ones are kept.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AIRequest } from "./ai/provider.js";
import { resolveConfig } from "./config.js";
import type { LanguageAdapter } from "./languages/adapter.js";
import { findAdapterForPath } from "./languages/adapter.js";
import { defaultAdapters } from "./languages/index.js";
import type { FileResult } from "./pipeline.js";
import { processFile } from "./pipeline.js";
import { commentPlanReply, FakeAIProvider } from "./testing/fake-provider.js";
import { commentAboveFirstMatch } from "./testing/scripted-replies.js";

const FIXTURES_DIR = join(import.meta.dirname, "..", "fixtures");
const PROBE = "Probe comment.";

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
  return processFile({ path: fixture.path, code }, resolveConfig(), {
    provider: new FakeAIProvider(reply),
    adapters,
  });
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
