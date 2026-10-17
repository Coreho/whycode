// Tests that formatting never runs code from the project unless the user
// opted in: a JavaScript Prettier config here writes a marker file whenever
// Prettier loads it, so the marker shows whether the project's code ran.
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, resolveConfig } from "./config.js";
import { typescriptAdapter } from "./languages/typescript.js";
import { processFile } from "./pipeline.js";
import { commentPlanReply, FakeAIProvider } from "./testing/fake-provider.js";

// Runs as ES module code: writes RAN.txt next to itself, then sets a style.
const CONFIG_THAT_RUNS = [
  'import { writeFileSync } from "node:fs";',
  'writeFileSync(new URL("./RAN.txt", import.meta.url), "ran");',
  "export default { semi: false };",
  "",
].join("\n");

describe("formatter config that runs code", () => {
  let project: string;
  const marker = () => join(project, "RAN.txt");

  beforeEach(async () => {
    // A fresh folder per test: Node runs a given module file only once.
    project = await mkdtemp(join(tmpdir(), "whycode-trust-"));
    await mkdir(join(project, ".git"));
    await writeFile(join(project, "prettier.config.mjs"), CONFIG_THAT_RUNS);
    await writeFile(join(project, "a.ts"), "const a = 1;\n");
  });

  afterEach(async () => {
    await rm(project, { recursive: true, force: true });
  });

  const run = (trustFormatterConfig?: boolean) =>
    processFile(
      {
        path: "a.ts",
        absolutePath: join(project, "a.ts"),
        code: "const a = 1;\n",
      },
      resolveConfig({}, trustFormatterConfig ? { trustFormatterConfig } : {}),
      {
        provider: new FakeAIProvider(commentPlanReply({})),
        adapters: [typescriptAdapter],
      },
    );

  it("is never run by default, and the note says how to opt in", async () => {
    const result = await run();
    expect(existsSync(marker())).toBe(false);
    expect(result.formatted).toBe(false);
    expect(result.warnings).toContain(
      "Formatting was skipped: the project's prettier.config.mjs is JavaScript, which Prettier would run. WhyCode doesn't run code from a project unless you pass --trust-formatter-config.",
    );
  });

  it("runs, and formats in the project's style, after the user opts in", async () => {
    const result = await run(true);
    expect(existsSync(marker())).toBe(true);
    expect(result.formatted).toBe(true);
    expect(result.outputCode).toBe("const a = 1\n");
  });

  it("can't be enabled by the project's own .whycoderc.json", () => {
    expect(() => resolveConfig({ trustFormatterConfig: true })).toThrow(
      ConfigError,
    );
    expect(() => resolveConfig({ trustFormatterConfig: true })).toThrow(
      /can't be set in \.whycoderc\.json, because the project controls that file/,
    );
  });
});
