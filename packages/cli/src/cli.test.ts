// End-to-end tests for `whycode check`: a temporary repository, the real
// core pipeline with the toy language, and a scripted AI provider.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AIProvider } from "@whycode/core";
import { MissingApiKeyError } from "@whycode/core";
import type { FakeResponse } from "@whycode/core/testing";
import {
  commentAboveFirstMatch,
  commentPlanReply,
  createToyAdapter,
  FakeAIProvider,
} from "@whycode/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CommandDeps } from "./run.js";
import { HELP_TEXT, runCli } from "./cli.js";
import type { CliIo } from "./io.js";

describe("whycode check", () => {
  let root: string;
  let stdout: string;
  let stderr: string;
  let provider: FakeAIProvider;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "whycode-cli-"));
    await mkdir(join(root, ".git"));
    stdout = "";
    stderr = "";
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function files(entries: Record<string, string>): Promise<void> {
    for (const [path, content] of Object.entries(entries)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content);
    }
  }

  const io = (cwd = root): CliIo => ({
    cwd,
    env: {},
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
    color: false,
    interactive: false,
    readStdin: () => Promise.resolve(""),
    ask: () => Promise.resolve(undefined),
  });

  function deps(
    responses: FakeResponse | FakeResponse[],
    createProvider?: CommandDeps["createProvider"],
  ): CommandDeps {
    provider = new FakeAIProvider(responses);
    return {
      adapters: [createToyAdapter()],
      createProvider: createProvider ?? (() => provider),
      concurrency: 2,
    };
  }

  const noComments = commentPlanReply({});

  it("prints a diff and exits 1 when a file would change", async () => {
    await files({ "src/app.toy": "start engine\nstop engine\n" });
    const code = await runCli(
      ["check", "src"],
      io(),
      deps(commentAboveFirstMatch(/stop/, "Shut down cleanly.")),
    );
    expect(code).toBe(1);
    expect(stdout).toContain("--- a/src/app.toy\n+++ b/src/app.toy");
    expect(stdout).toContain("+# Shut down cleanly.\n");
    expect(stdout).toContain("1 file would change, 0 unchanged, 0 skipped.");
    expect(stderr).toContain("Checking 1 file with fake");
  });

  it("never writes files", async () => {
    await files({ "app.toy": "run   \n" });
    await runCli(
      ["check", "."],
      io(),
      deps(commentAboveFirstMatch(/run/, "Go.")),
    );
    expect(await readFile(join(root, "app.toy"), "utf8")).toBe("run   \n");
  });

  it("exits 0 when nothing would change", async () => {
    await files({ "app.toy": "run\n" });
    const code = await runCli(["check", "app.toy"], io(), deps(noComments));
    expect(code).toBe(0);
    expect(stdout).toBe(
      "app.toy: nothing to change\n0 files would change, 1 unchanged, 0 skipped.\n",
    );
  });

  it("exits 1 and says so when comments were discarded, even with no diff", async () => {
    await files({ "app.toy": "run\n" });
    const corrupting: CommandDeps = {
      ...deps(commentAboveFirstMatch(/run/, "Go.")),
      adapters: [
        createToyAdapter({ corruptOnReformat: (code) => `${code}\nextra` }),
      ],
    };
    const code = await runCli(["check", "app.toy"], io(), corrupting);
    expect(code).toBe(1);
    expect(stdout).toContain(
      "app.toy: comments discarded because verification failed; nothing else to change",
    );
    expect(stdout).toMatch(
      /Notes for app\.toy:\n {2}- AI comments were discarded/,
    );
    expect(stdout).toContain("1 with comments discarded");
  });

  it("prints suggestions for existing comments", async () => {
    await files({ "app.toy": "# old note\nrun\n" });
    const reply = commentPlanReply({
      existingCommentSuggestions: [
        {
          line: 1,
          original: "# old note",
          suggested: "# Starts the job.",
          reason: "Says what it does.",
        },
      ],
    });
    await runCli(["check", "app.toy"], io(), deps(reply));
    expect(stdout).toContain(
      [
        "Suggested rewrites of existing comments in app.toy:",
        "  line 1:",
        "    - # old note",
        "    + # Starts the job.",
        "    why: Says what it does.",
      ].join("\n"),
    );
    expect(stdout).toContain("1 comment suggestion.");
  });

  it("lists gitignored and secret files as skipped and never sends them", async () => {
    await files({
      ".gitignore": "build/\nlocal.toy\n",
      ".env": "API_TOKEN=abc",
      "build/out.toy": "x\n",
      "local.toy": "x\n",
      "app.toy": "run\n",
    });
    await runCli(["check", ".", ".env"], io(), deps(noComments));
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.user).toContain("run");
    expect(stdout).toContain(
      [
        "Skipped 3 paths:",
        "  may hold secrets (env, key or credentials file), so it is never read:",
        "    .env",
        "  ignored by .gitignore:",
        "    build/",
        "    local.toy",
      ].join("\n"),
    );
  });

  it("applies include and exclude from .whycoderc.json", async () => {
    await files({
      ".whycoderc.json": JSON.stringify({
        include: ["src/**"],
        exclude: ["**/*.test.toy"],
      }),
      "src/app.toy": "run\n",
      "src/app.test.toy": "run\n",
      "tools/gen.toy": "run\n",
    });
    await runCli(["check", "."], io(), deps(noComments));
    expect(provider.requests).toHaveLength(1);
    expect(stdout).toContain("tools/gen.toy");
    expect(stdout).toContain("src/app.test.toy");
  });

  it("lets flags override the config file", async () => {
    await files({
      ".whycoderc.json": JSON.stringify({
        commentLevel: "light",
        model: "file-model",
      }),
      "app.toy": "run\n",
    });
    let seenConfig: unknown;
    await runCli(
      [
        "check",
        "app.toy",
        "--comment-level",
        "heavy",
        "--provider",
        "openrouter",
        "--model",
        "flag-model",
      ],
      io(),
      deps(noComments, (config) => {
        seenConfig = config;
        return provider;
      }),
    );
    expect(seenConfig).toMatchObject({
      commentLevel: "heavy",
      provider: "openrouter",
      model: "flag-model",
    });
  });

  it("resolves paths from a subdirectory and shows them relative to the root", async () => {
    await files({ "src/app.toy": "stop\n" });
    await runCli(
      ["check", "app.toy"],
      io(join(root, "src")),
      deps(commentAboveFirstMatch(/stop/, "Halt.")),
    );
    expect(stdout).toContain("+++ b/src/app.toy");
  });

  it("reports files that could not be processed and exits 2", async () => {
    await files({ "app.toy": "run\n" });
    const code = await runCli(
      ["check", "app.toy"],
      io(),
      deps(new Error("rate limited")),
    );
    expect(code).toBe(2);
    expect(stdout).toContain(
      [
        "Could not process 1 file:",
        '  AI provider "fake" failed: rate limited:',
        "    app.toy",
      ].join("\n"),
    );
    expect(stdout).toContain("0 skipped, 1 failed.");
  });

  it("keeps results in path order while files are processed concurrently", async () => {
    await files({ "a.toy": "a\n", "b.toy": "b\n", "c.toy": "c\n" });
    let calls = 0;
    const slowFirst: AIProvider = {
      name: "slow",
      complete: async (request) => {
        calls += 1;
        const delay = calls === 1 ? 30 : 0;
        await new Promise((resolve) => setTimeout(resolve, delay));
        const target = /\| (\w)$/m.exec(request.user)?.[1] ?? "?";
        return commentPlanReply({
          insertions: [
            { line: 1, position: "above", text: `About ${target}.` },
          ],
        });
      },
    };
    await runCli(
      ["check", "."],
      io(),
      deps(noComments, () => slowFirst),
    );
    const order = [...stdout.matchAll(/\+# About (\w)\./g)].map((m) => m[1]);
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("fails with exit 2 and no AI call for a path that doesn't exist", async () => {
    await files({ "app.toy": "run\n" });
    const code = await runCli(
      ["check", "app.toy", "nope.toy"],
      io(),
      deps(noComments),
    );
    expect(code).toBe(2);
    expect(stderr).toContain("whycode: nope.toy: no such file or directory");
    expect(provider.requests).toHaveLength(0);
  });

  it("fails with exit 2 when the API key is missing", async () => {
    await files({ "app.toy": "run\n" });
    const code = await runCli(
      ["check", "app.toy"],
      io(),
      deps(noComments, () => {
        throw new MissingApiKeyError("ANTHROPIC_API_KEY is not set.");
      }),
    );
    expect(code).toBe(2);
    expect(stderr).toBe("whycode: ANTHROPIC_API_KEY is not set.\n");
  });

  it("needs no API key when there is nothing to process", async () => {
    await files({ "notes.md": "hi\n" });
    const code = await runCli(
      ["check", "."],
      io(),
      deps(noComments, () => {
        throw new MissingApiKeyError("ANTHROPIC_API_KEY is not set.");
      }),
    );
    expect(code).toBe(0);
  });

  it("fails with exit 2 on an invalid config file", async () => {
    await files({
      ".whycoderc.json": '{ "commentLevel": "loud" }',
      "app.toy": "run\n",
    });
    const code = await runCli(["check", "."], io(), deps(noComments));
    expect(code).toBe(2);
    expect(stderr).toMatch(/Invalid WhyCode configuration/);
  });
});

describe("whycode", () => {
  let stdout = "";
  let stderr = "";
  const io: CliIo = {
    cwd: ".",
    env: {},
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
    color: false,
    interactive: false,
    readStdin: () => Promise.resolve(""),
    ask: () => Promise.resolve(undefined),
  };

  beforeEach(() => {
    stdout = "";
    stderr = "";
  });

  it("prints help", async () => {
    expect(await runCli(["--help"], io)).toBe(0);
    expect(stdout).toBe(HELP_TEXT);
  });

  it("prints the package version", async () => {
    expect(await runCli(["--version"], io)).toBe(0);
    expect(stdout).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("rejects usage errors with exit 2", async () => {
    expect(await runCli(["check"], io)).toBe(2);
    expect(stderr).toMatch(/needs at least one file or directory/);
  });
});
