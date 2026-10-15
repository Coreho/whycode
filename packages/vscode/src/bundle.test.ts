// Runs the built extension (dist/extension.js, made by `pnpm build`) the way
// VS Code does: a copy of dist/ is loaded with require() as CommonJS, and
// only the "vscode" module comes from outside (the fake). Cleaning up real
// TypeScript and Python files needs the bundled Prettier, the web-tree-sitter
// runtime and the grammars, all found relative to the copied bundle.
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { commentAboveFirstMatch } from "@whycode/core/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fakeVscode from "./testing/fake-vscode.js";
import { fake, fakeChatModel, pick } from "./testing/fake-vscode.js";

const distDir = fileURLToPath(new URL("../dist", import.meta.url));
const built = existsSync(join(distDir, "extension.js"));

interface Extension {
  activate(context: { subscriptions: unknown[]; extensionPath: string }): void;
}

let work: string;
let project: string;

/** Copies dist/ next to a stub "vscode" package and loads the bundle. */
async function loadBundle(): Promise<void> {
  const extensionDir = join(work, "extension");
  await cp(distDir, join(extensionDir, "dist"), { recursive: true });
  await writeFile(join(extensionDir, "package.json"), '{ "name": "x" }');
  const stubDir = join(extensionDir, "node_modules", "vscode");
  await mkdir(stubDir, { recursive: true });
  await writeFile(
    join(stubDir, "index.js"),
    "module.exports = globalThis.whycodeFakeVscode;\n",
  );
  Object.assign(globalThis, { whycodeFakeVscode: fakeVscode });
  const require = createRequire(import.meta.url);
  const extension = require(
    join(extensionDir, "dist", "extension.js"),
  ) as Extension;
  extension.activate({ subscriptions: [], extensionPath: extensionDir });
}

/** Comments the first function, or a line inside a template literal. */
function scriptedReply(prompt: string): string {
  const request = { system: "", user: prompt };
  if (prompt.includes("File: template.ts")) {
    return commentAboveFirstMatch(/<h1>/, "Heading.")(request);
  }
  return commentAboveFirstMatch(/function|def /, "Adds two numbers.")(request);
}

describe.skipIf(!built)("the built extension (run pnpm build first)", () => {
  beforeAll(async () => {
    fake.reset();
    work = await mkdtemp(join(tmpdir(), "whycode-bundle-"));
    project = join(work, "project");
    await mkdir(join(project, ".git"), { recursive: true });
    await writeFile(
      join(project, "app.ts"),
      "export function add(a:number,b:number){return a+b}\n",
    );
    await writeFile(
      join(project, "util.py"),
      "def add(a, b):\n    return a + b\n",
    );
    await writeFile(
      join(project, "template.ts"),
      "export const page = `\n<h1>Title</h1>\n`;\n",
    );
    await loadBundle();
  });

  afterAll(() => rm(work, { recursive: true, force: true }));

  it("formats with Prettier and verifies with tree-sitter from dist/", async () => {
    fake.workspaceFolders = [project];
    fake.models = [fakeChatModel({ id: "claude-sonnet-5.5" }, scriptedReply)];
    fake.quickPickAnswers.push(pick("Apply"), pick("Apply"));
    const folder = fakeVscode.Uri.file(project);

    await fake.runCommand("whycode.cleanUp", folder, [folder]);

    const output = fake.output.lines.join("\n");
    expect(output).not.toContain("Could not process");
    expect(await readFile(join(project, "app.ts"), "utf8")).toBe(
      "// Adds two numbers.\nexport function add(a: number, b: number) {\n  return a + b;\n}\n",
    );
    expect(await readFile(join(project, "util.py"), "utf8")).toBe(
      "# Adds two numbers.\ndef add(a, b):\n    return a + b\n",
    );
    // A comment inside the template literal would change the string, and
    // the tree-sitter token check catches it.
    expect(output).toMatch(/only formatting offered \(1\):\n {2}template\.ts/);
    expect(await readFile(join(project, "template.ts"), "utf8")).toBe(
      "export const page = `\n<h1>Title</h1>\n`;\n",
    );
  }, 60_000);
});
