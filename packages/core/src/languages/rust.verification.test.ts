// Exercises Rust fixtures through the real pipeline, including unsafe string
// and doc-comment placements that verification must catch.
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AIRequest } from "../ai/provider.js";
import { resolveConfig } from "../config.js";
import { processFile } from "../pipeline.js";
import { FakeAIProvider } from "../testing/fake-provider.js";
import {
  commentAboveEveryMatch,
  commentAboveFirstMatch,
} from "../testing/scripted-replies.js";
import type { LanguageAdapter } from "./adapter.js";
import { createRustAdapter, rustAdapter } from "./rust.js";

const rustfmtInstalled = spawnSync("rustfmt", ["--version"]).status === 0;
const FIXTURES = join(import.meta.dirname, "..", "..", "fixtures", "rust");
const PROBE = "Probe comment.";
const DEFINITION =
  /^\s*(?:pub\s+)?(?:async\s+)?(?:fn|struct|enum|impl|trait)\b/;
const unformattedRust = createRustAdapter({
  runProcess: () => Promise.resolve({ kind: "not-found" }),
  readTextFile: () => Promise.resolve(undefined),
});

async function runCode(
  code: string,
  reply: (request: AIRequest) => string,
  adapter = unformattedRust,
) {
  return processFile(
    { path: join(FIXTURES, "verification.rs"), code },
    resolveConfig(),
    { provider: new FakeAIProvider(reply), adapters: [adapter] },
  );
}

async function runFixture(
  name: string,
  target: RegExp,
  adapter = unformattedRust,
  text = PROBE,
) {
  const code = await readFile(join(FIXTURES, name), "utf8");
  return runCode(code, commentAboveFirstMatch(target, text), adapter);
}

async function expectClean(code: string) {
  const tokens = await rustAdapter.tokens(code);
  expect(tokens.length).toBeGreaterThan(0);
  expect(tokens.filter((token) => token.startsWith("<<"))).toEqual([]);
}

describe("Rust fixtures", () => {
  it.each(["messy.rs", "verification.rs"])(
    "%s parses lifetimes, chars, macros, attributes and nested comments cleanly",
    async (name) => {
      await expectClean(await readFile(join(FIXTURES, name), "utf8"));
    },
  );

  async function expectMessyPipeline(
    adapter: LanguageAdapter,
    formatted: boolean,
  ) {
    const code = await readFile(join(FIXTURES, "messy.rs"), "utf8");
    const result = await runCode(
      code,
      commentAboveEveryMatch(DEFINITION, PROBE),
      adapter,
    );
    expect(result.languageId).toBe("rust");
    expect(result.status).toBe("changed");
    expect(result.verification).toBe("passed");
    expect(result.formatted).toBe(formatted);
    await expectClean(result.outputCode);
    const definitions = result.outputCode
      .split("\n")
      .filter((line) => DEFINITION.test(line));
    const comments = result.outputCode
      .split("\n")
      .filter((line) => line.trim() === `// ${PROBE}`);
    expect(definitions.length).toBeGreaterThan(8);
    expect(comments).toHaveLength(definitions.length);
    expect(result.warnings).toEqual(
      formatted
        ? []
        : ["No formatter available for rust; formatting was skipped."],
    );
  }

  it("comments above every definition pass without rustfmt", async () => {
    await expectMessyPipeline(unformattedRust, false);
  });

  it.skipIf(!rustfmtInstalled)(
    "comments above every definition pass with real rustfmt",
    async () => {
      await expectMessyPipeline(rustAdapter, true);
    },
  );
});

describe("Rust misplaced string comments", () => {
  it.each([
    ["normal string", /^normal continues/],
    ["raw string", /^raw continues/],
    ["byte string", /^bytes continue/],
    ["later line of continued string", /^continued ends/],
  ])("discards a comment inside a %s", async (_kind, target) => {
    const result = await runFixture("verification.rs", target);
    expect(result.verification).toBe("failed");
    expect(result.outputCode).toBe(
      await readFile(join(FIXTURES, "verification.rs"), "utf8"),
    );
    expect(result.outputCode).not.toContain(PROBE);
    expect(result.warnings.join("\n")).toMatch(
      /tokens changed \(token \d+: expected/,
    );
  });

  it("refuses an insertion immediately after a string's backslash continuation", async () => {
    const result = await runFixture("verification.rs", /^\s*continued resumes/);
    expect(result.outputCode).not.toContain(PROBE);
    expect(result.warnings.join("\n")).toMatch(/backslash line continuation/);
  });

  it("tokenization also catches an insertion after a continuation if the insertion guard is bypassed", async () => {
    const before = 'const S: &str = "start \\\n    end";';
    const after = before.replace("    end", "    // changed value\n    end");
    expect(await rustAdapter.tokens(after)).not.toEqual(
      await rustAdapter.tokens(before),
    );
  });

  it.skipIf(!rustfmtInstalled)(
    "also discards a string comment when real rustfmt is enabled",
    async () => {
      const original = await readFile(
        join(FIXTURES, "verification.rs"),
        "utf8",
      );
      const result = await runFixture(
        "verification.rs",
        /^raw continues/,
        rustAdapter,
      );
      expect(result.verification).toBe("failed");
      expect(result.outputCode).toBe(
        (await rustAdapter.format(original, join(FIXTURES, "verification.rs")))
          .code,
      );
    },
  );
});

describe("Rust harmless comment placements", () => {
  it.each([
    ["between doc lines", /^\/\/\/ Keeps the second/],
    ["between doc comment and item", /^#\[derive/],
    ["between derive attribute and item", /^pub struct Record/],
    ["between cfg attribute and item", /^mod tests/],
    ["inside a macro invocation", /^\s*value,$/],
    ["inside a macro_rules body", /^\s*\$value \* 2/],
    ["inside a multi-line match arm", /^\s*double!\(values/],
  ])("keeps a comment %s", async (_place, target) => {
    const result = await runFixture("verification.rs", target);
    expect(result.verification).toBe("passed");
    expect(result.outputCode).toContain(`// ${PROBE}`);
    await expectClean(result.outputCode);
    const docLines = (code: string) =>
      code.split("\n").filter((line) => /^\s*(\/\/[/!]|\/\*[*!])/.test(line));
    expect(docLines(result.outputCode)).toEqual(
      docLines(await readFile(join(FIXTURES, "verification.rs"), "utf8")),
    );
  });

  it.each(["/// sneaky", "! inner"])(
    "writes AI text %j as an ordinary // comment",
    async (text) => {
      const result = await runFixture(
        "verification.rs",
        /^\s*let brace/,
        unformattedRust,
        text,
      );
      expect(result.verification).toBe("passed");
      const inserted = result.outputCode
        .split("\n")
        .find((line) => /sneaky|inner$/.test(line));
      expect(inserted?.trimStart()).toMatch(/^\/\/ /);
      await expectClean(result.outputCode);
    },
  );
});

describe("Rust verification detects logic changes", () => {
  it("discards AI changes and names the differing operator", async () => {
    let calls = 0;
    const adapter: LanguageAdapter = {
      ...unformattedRust,
      async format(code, path) {
        const result = await unformattedRust.format(code, path);
        if (++calls === 1) return result;
        const mutated = result.code.replace("$value * 2", "$value + 2");
        expect(mutated).not.toBe(result.code);
        return { ...result, code: mutated };
      },
    };
    const result = await runFixture(
      "verification.rs",
      /^pub fn calculate/,
      adapter,
    );
    expect(result.verification).toBe("failed");
    expect(result.outputCode).toBe(
      await readFile(join(FIXTURES, "verification.rs"), "utf8"),
    );
    expect(result.outputCode).not.toContain(PROBE);
    expect(result.warnings.join("\n")).toMatch(/expected "\*", found "\+"/);
  });
});

describe("Rust doc comments", () => {
  it("discards a comment that lands inside a block doc comment", async () => {
    const code = "/**\nOriginal documentation.\n*/\npub fn example() {}\n";
    const result = await runCode(
      code,
      commentAboveFirstMatch(/^Original documentation/, PROBE),
    );
    expect(result.verification).toBe("failed");
    expect(result.outputCode).toBe(code);
  });
});
