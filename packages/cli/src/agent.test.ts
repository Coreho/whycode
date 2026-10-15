// End-to-end tests for the agent commands: an external model's reply goes
// through `prompt` -> `preview` -> `write`, with the core's privacy rules,
// verification and the fingerprint check in force.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { commentPlanReply, createToyAdapter } from "@whycode/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "./cli.js";
import type { CliIo } from "./io.js";
import type { CommandDeps } from "./run.js";

describe("agent commands", () => {
  let root: string;
  let stdout: string;
  let stderr: string;
  let stdin: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "whycode-agent-"));
    await mkdir(join(root, ".git"));
    stdout = "";
    stderr = "";
    stdin = "";
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

  const read = (path: string) => readFile(join(root, path), "utf8");

  const io = (): CliIo => ({
    cwd: root,
    env: {},
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
    color: false,
    interactive: false,
    ask: () => Promise.resolve(undefined),
    readStdin: () => Promise.resolve(stdin),
  });

  // No provider is ever needed: the agent's model replies instead.
  const deps: CommandDeps = {
    adapters: [createToyAdapter()],
    createProvider: () => {
      throw new Error("agent commands must not create a provider");
    },
    concurrency: 1,
  };

  const run = (...argv: string[]) => runCli(argv, io(), deps);

  const plan = commentPlanReply({
    insertions: [{ line: 2, position: "above", text: "Shut down." }],
    existingCommentSuggestions: [
      {
        line: 1,
        original: "# go",
        suggested: "# Start up.",
        reason: "Clearer.",
      },
    ],
  });

  async function preview(path: string): Promise<string> {
    stdin = plan;
    stdout = "";
    expect(await run("preview", path, "--plan", "-")).toBe(0);
    const fingerprint = /Fingerprint: ([0-9a-f]{16})/.exec(stdout)?.[1];
    if (fingerprint === undefined)
      throw new Error(`no fingerprint in:\n${stdout}`);
    return fingerprint;
  }

  it("prompt prints the system prompt once and each file's numbered code", async () => {
    await files({
      "a.toy": "# go\nstop\n",
      "b.toy": "run\n",
      ".env": "TOKEN=1",
      ".gitignore": "gen/\n",
      "gen/x.toy": "x\n",
    });
    expect(await run("prompt", ".", ".env", "--comment-level", "heavy")).toBe(
      0,
    );
    expect(stdout).toContain("comment level: heavy");
    expect(stdout.match(/===== SYSTEM PROMPT/g)).toHaveLength(1);
    expect(stdout).toContain("===== REPLY SCHEMA (JSON Schema) =====");
    expect(stdout).toContain(
      "===== FILE: a.toy =====\nFile: a.toy (toy)\n\n1| # go\n2| stop",
    );
    expect(stdout).toContain("===== FILE: b.toy =====");
    expect(stdout).toContain("===== SKIPPED (never read) =====");
    expect(stdout).toMatch(/\.env: may hold secrets/);
    expect(stdout).toContain("gen/: ignored by .gitignore");
    expect(stdout).not.toContain("TOKEN=1");
  });

  it("prompt --list lists the files without their code", async () => {
    await files({ "a.toy": "# go\nstop\n", "b.toy": "run\n", ".env": "A=1" });
    expect(await run("prompt", ".", "--list")).toBe(0);
    expect(stdout).toBe(
      [
        "===== FILES WhyCode would process (2) =====",
        "a.toy",
        "b.toy",
        "",
        "===== SKIPPED (never read) =====",
        ".env: may hold secrets (env, key or credentials file), so it is never read",
        "",
      ].join("\n"),
    );
  });

  it("preview shows the diff, numbered suggestions and a fingerprint, and writes nothing", async () => {
    await files({ "a.toy": "# go\nstop\n" });
    await preview("a.toy");
    expect(stdout).toContain("Preview of a.toy (verification: passed).");
    expect(stdout).toContain("+# Shut down.");
    expect(stdout).toContain("(1 of 1)");
    expect(stdout).toMatch(
      /whycode write a\.toy --plan <the same plan> --fingerprint [0-9a-f]{16} \[--accept-suggestions/,
    );
    expect(await read("a.toy")).toBe("# go\nstop\n");
  });

  it("write applies the previewed result and only the accepted suggestions", async () => {
    await files({ "a.toy": "# go\nstop\n" });
    const fingerprint = await preview("a.toy");
    const planFile = join(root, "..", `plan-${Date.now()}.json`);
    await writeFile(planFile, plan);
    try {
      expect(
        await run(
          "write",
          "a.toy",
          "--plan",
          planFile,
          "--fingerprint",
          fingerprint,
          "--accept-suggestions",
          "1",
        ),
      ).toBe(0);
    } finally {
      await rm(planFile, { force: true });
    }
    expect(await read("a.toy")).toBe("# Start up.\n# Shut down.\nstop\n");
    expect(stdout).toContain("Wrote a.toy (1 comment suggestion(s) applied).");
  });

  it("write refuses when the file changed after the preview", async () => {
    await files({ "a.toy": "# go\nstop\n" });
    const fingerprint = await preview("a.toy");
    await files({ "a.toy": "# go\nstop\nmore\n" });
    stdin = plan;
    expect(
      await run("write", "a.toy", "--plan", "-", "--fingerprint", fingerprint),
    ).toBe(2);
    expect(stderr).toMatch(/changed since the preview, so nothing was written/);
    expect(await read("a.toy")).toBe("# go\nstop\nmore\n");
  });

  it("write refuses a different plan than the one previewed", async () => {
    await files({ "a.toy": "# go\nstop\n" });
    const fingerprint = await preview("a.toy");
    stdin = commentPlanReply({
      insertions: [{ line: 2, position: "above", text: "Something else." }],
    });
    expect(
      await run("write", "a.toy", "--plan", "-", "--fingerprint", fingerprint),
    ).toBe(2);
    expect(await read("a.toy")).toBe("# go\nstop\n");
  });

  it("write refuses a plan whose suggested comment text changed after the preview", async () => {
    // The reported case: same code changes, different suggestion text.
    await files({ "a.toy": "# go\nstop\n" });
    const fingerprint = await preview("a.toy");
    stdin = commentPlanReply({
      insertions: [{ line: 2, position: "above", text: "Shut down." }],
      existingCommentSuggestions: [
        {
          line: 1,
          original: "# go",
          suggested: "# Text nobody reviewed.",
          reason: "Clearer.",
        },
      ],
    });
    expect(
      await run(
        "write",
        "a.toy",
        "--plan",
        "-",
        "--fingerprint",
        fingerprint,
        "--accept-suggestions",
        "1",
      ),
    ).toBe(2);
    expect(stderr).toMatch(/changed since the preview/);
    expect(await read("a.toy")).toBe("# go\nstop\n");
  });

  it("write rejects suggestion numbers the preview didn't list", async () => {
    await files({ "a.toy": "# go\nstop\n" });
    const fingerprint = await preview("a.toy");
    stdin = plan;
    expect(
      await run(
        "write",
        "a.toy",
        "--plan",
        "-",
        "--fingerprint",
        fingerprint,
        "--accept-suggestions",
        "2",
      ),
    ).toBe(2);
    expect(stderr).toMatch(/there is no suggestion 2/);
  });

  it("reports an invalid plan with the validation error, so the agent can fix it", async () => {
    await files({ "a.toy": "stop\n" });
    stdin = '{"insertions": [{"line": "two"}]}';
    expect(await run("preview", "a.toy", "--plan", "-")).toBe(2);
    expect(stderr).toMatch(
      /could not be processed: AI returned an invalid reply/,
    );
  });

  it("never processes a secret or gitignored file", async () => {
    await files({ ".env": "A=1", ".gitignore": "gen/\n", "gen/x.toy": "x\n" });
    stdin = plan;
    expect(await run("preview", ".env", "--plan", "-")).toBe(2);
    expect(stderr).toMatch(/\.env can't be processed: may hold secrets/);
    expect(await run("preview", "gen/x.toy", "--plan", "-")).toBe(2);
    expect(stderr).toMatch(/ignored by \.gitignore/);
  });

  it("keeps the comments out when verification fails, and says so", async () => {
    await files({ "a.toy": "stop\n" });
    const corrupting: CommandDeps = {
      ...deps,
      adapters: [
        createToyAdapter({ corruptOnReformat: (code) => `${code}\nextra` }),
      ],
    };
    stdin = plan;
    expect(
      await runCli(["preview", "a.toy", "--plan", "-"], io(), corrupting),
    ).toBe(0);
    expect(stdout).toContain("verification: failed");
    expect(stdout).toMatch(/AI comments were discarded/);
  });

  it("rejects flags that don't belong to the command", async () => {
    expect(await run("preview", "a.toy", "--plan", "-", "--yes")).toBe(2);
    expect(stderr).toMatch(/--yes doesn't apply to "whycode preview"/);
    expect(await run("write", "a.toy", "--plan", "-")).toBe(2);
    expect(stderr).toMatch(/needs the --fingerprint/);
  });
});
