// Tests for keeping the safe comments when one insertion fails
// verification: unsafe ones are dropped individually with a warning, the
// formatter runs a bounded number of times, and real Python and TypeScript
// files with a comment aimed inside a multi-line string keep the others.
import { describe, expect, it } from "vitest";
import type { AIRequest } from "./ai/provider.js";
import { resolveConfig } from "./config.js";
import type { LanguageAdapter } from "./languages/adapter.js";
import { pythonAdapter } from "./languages/python.js";
import { typescriptAdapter } from "./languages/typescript.js";
import { processFile } from "./pipeline.js";
import { commentPlanReply, FakeAIProvider } from "./testing/fake-provider.js";
import { numberedLines } from "./testing/scripted-replies.js";
import { createToyAdapter } from "./testing/toy-adapter.js";

const config = resolveConfig();

/** Replies with a comment above every numbered line matching `pattern`. */
const commentAbove = (pattern: RegExp) => (request: AIRequest) =>
  commentPlanReply({
    insertions: numberedLines(request)
      .filter((line) => pattern.test(line.text))
      .map((line) => ({
        line: line.number,
        position: "above" as const,
        text: "Explains this line.",
      })),
  });

/**
 * The toy language plus a string block between lines of three quotes, whose
 * lines (comments included) are part of the string, and a formatter counter.
 */
function stringBlockAdapter(): LanguageAdapter & { formatCalls: () => number } {
  const toy = createToyAdapter();
  let calls = 0;
  return {
    ...toy,
    format(code, path) {
      calls += 1;
      return toy.format(code, path);
    },
    async tokens(code) {
      const tokens: string[] = [];
      let inString = false;
      for (const line of code.split("\n")) {
        if (line.trim() === '"""') {
          inString = !inString;
          tokens.push('"""');
        } else if (inString) {
          tokens.push(`string:${line}`);
        } else {
          tokens.push(...(await toy.tokens(line)));
        }
      }
      return tokens;
    },
    formatCalls: () => calls,
  };
}

describe("processFile: salvaging comments", () => {
  it("drops only the comment that lands inside a string, with a bounded number of formatter runs", async () => {
    const statements = Array.from({ length: 10 }, (_, i) => `step${i}`);
    const code = [...statements, '"""', "inside", '"""', ""].join("\n");
    const adapter = stringBlockAdapter();
    const provider = new FakeAIProvider(commentAbove(/^(step\d|inside)$/));

    const result = await processFile({ path: "a.toy", code }, config, {
      provider,
      adapters: [adapter],
    });

    expect(result.verification).toBe("passed");
    expect(result.commentsAdded).toBe(10);
    expect(result.outputCode).toContain('"""\ninside\n"""');
    expect(result.warnings).toEqual([
      expect.stringMatching(
        /^Dropped the comment for line 12: it would change the code's tokens/,
      ) as string,
    ]);
    expect(adapter.formatCalls()).toBeLessThanOrEqual(3);
  });

  it("keeps formatting only when no comment is unsafe on its own", async () => {
    const adapter = createToyAdapter({
      corruptOnReformat: (code) => `${code}\nextra`,
    });
    const provider = new FakeAIProvider(commentAbove(/start|stop/));
    const result = await processFile(
      { path: "a.toy", code: "start\nstop\n" },
      config,
      { provider, adapters: [adapter] },
    );
    expect(result.verification).toBe("failed");
    expect(result.commentsAdded).toBe(0);
  });

  it("keeps the safe comments in Python when one lands inside a triple-quoted string", async () => {
    const code = [
      "def greet(name):",
      '    message = """Hello,',
      "{name}!",
      '"""',
      "    return message.format(name=name)",
      "",
    ].join("\n");
    const provider = new FakeAIProvider(
      commentAbove(/def greet|\{name\}!|return message/),
    );
    const result = await processFile({ path: "greet.py", code }, config, {
      provider,
      adapters: [pythonAdapter],
    });
    expect(result.verification).toBe("passed");
    expect(result.commentsAdded).toBe(2);
    expect(result.outputCode).toContain('"""Hello,\n{name}!\n"""');
    expect(
      result.warnings.some((w) => w.startsWith("Dropped the comment")),
    ).toBe(true);
  });

  it("keeps the safe comments in TypeScript when one lands inside a template literal", async () => {
    const code = [
      "export function page(title: string): string {",
      "  const html = `",
      "<h1>${title}</h1>",
      "`;",
      "  return html;",
      "}",
      "",
    ].join("\n");
    const provider = new FakeAIProvider(
      commentAbove(/export function|<h1>|return html/),
    );
    const result = await processFile({ path: "page.ts", code }, config, {
      provider,
      adapters: [typescriptAdapter],
    });
    expect(result.verification).toBe("passed");
    expect(result.commentsAdded).toBe(2);
    expect(result.outputCode).toContain("`\n<h1>${title}</h1>\n`");
  });
});
