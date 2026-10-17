// Runs the action offline with real collection/pipeline work and fake GitHub/AI edges.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createToyAdapter,
  FakeAIProvider,
  commentAboveFirstMatch,
  commentPlanReply,
} from "@whycode/core/testing";
import { typescriptAdapter } from "@whycode/core";
import { runAction } from "./run.js";
import type { ActionOptions, ChangedFile, GitHubClient } from "./run.js";

const folders: string[] = [];
const sha = "1234567890abcdef";
const blobSha = (code: string) =>
  createHash("sha1")
    .update(`blob ${Buffer.byteLength(code)}\0${code}`)
    .digest("hex");
const changed = (
  filename: string,
  code: string,
  patch = "@@ -1 +1 @@\n-old\n+run()\n",
): ChangedFile => ({ filename, sha: blobSha(code), status: "modified", patch });

async function fixture(files: Record<string, string> = { "a.toy": "run()\n" }) {
  const workspace = await mkdtemp(join(tmpdir(), "whycode-action-"));
  folders.push(workspace);
  await mkdir(join(workspace, ".git"));
  for (const [path, code] of Object.entries(files)) {
    await mkdir(join(workspace, path, ".."), { recursive: true });
    await writeFile(join(workspace, path), code);
  }
  const provider = new FakeAIProvider([
    commentAboveFirstMatch(/run/, "Explain why"),
  ]);
  const github = {
    listFiles: vi
      .fn<GitHubClient["listFiles"]>()
      .mockResolvedValue([changed("a.toy", files["a.toy"] ?? "run()\n")]),
    getHead: vi.fn<GitHubClient["getHead"]>().mockResolvedValue(sha),
    createReview: vi
      .fn<GitHubClient["createReview"]>()
      .mockResolvedValue(undefined),
  };
  const maskSecret = vi.fn();
  const options: ActionOptions = {
    workspace,
    eventName: "pull_request",
    payload: { pull_request: { number: 3, head: { sha } } },
    repo: { owner: "owner", repo: "repo" },
    inputs: { apiKey: "fake-test-key" },
    env: {},
    github,
    provider,
    adapters: [createToyAdapter()],
    maskSecret,
    readHead: () => Promise.resolve(sha),
  };
  return { options, provider, github, maskSecret, workspace };
}

afterEach(async () => {
  await Promise.all(
    folders.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("code from the pull request", () => {
  // Writes RAN.txt whenever Prettier loads it.
  const configThatRuns =
    'import { writeFileSync } from "node:fs";\nwriteFileSync(new URL("./RAN.txt", import.meta.url), "ran");\nexport default { semi: false };\n';

  it("never runs a JavaScript Prettier config the PR adds", async () => {
    const { options, github, workspace } = await fixture({
      "a.ts": "const a = 1;\n",
      "prettier.config.mjs": configThatRuns,
    });
    github.listFiles.mockResolvedValue([
      changed("a.ts", "const a = 1;\n"),
      changed("prettier.config.mjs", configThatRuns),
    ]);
    await runAction({
      ...options,
      adapters: [typescriptAdapter],
      provider: new FakeAIProvider(commentPlanReply({})),
    });
    expect(existsSync(join(workspace, "RAN.txt"))).toBe(false);
  });

  it("refuses a .whycoderc.json that tries to grant that trust", async () => {
    const { options, workspace } = await fixture({
      "a.ts": "const a = 1;\n",
      "prettier.config.mjs": configThatRuns,
      ".whycoderc.json": '{"trustFormatterConfig":true}',
    });
    await expect(
      runAction({ ...options, adapters: [typescriptAdapter] }),
    ).rejects.toThrow(/trustFormatterConfig can't be set in \.whycoderc\.json/);
    expect(existsSync(join(workspace, "RAN.txt"))).toBe(false);
  });
});

describe("job summary", () => {
  it("writes each file's verdict and the suggestion count", async () => {
    const { options } = await fixture();
    const summaries: string[] = [];
    await runAction({
      ...options,
      writeSummary: (markdown) => {
        summaries.push(markdown);
        return Promise.resolve();
      },
    });
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toContain("## WhyCode");
    expect(summaries[0]).toContain(
      "| a.toy | 1 comment added; comment insertion preserved the checked code tokens |",
    );
    expect(summaries[0]).toContain(
      "1 suggestion(s) were posted as one review on the pull request.",
    );
  });

  it("is written for a clean run too, which posts no review", async () => {
    const { options, github } = await fixture();
    const summaries: string[] = [];
    await runAction({
      ...options,
      provider: new FakeAIProvider(commentPlanReply({})),
      writeSummary: (markdown) => {
        summaries.push(markdown);
        return Promise.resolve();
      },
    });
    expect(github.createReview).not.toHaveBeenCalled();
    expect(summaries[0]).toContain("| a.toy | nothing to change |");
    expect(summaries[0]).toContain("No suggestions were posted.");
  });

  it("escapes markup in file names", async () => {
    const { options, github } = await fixture({ "a_b.toy": "run()\n" });
    github.listFiles.mockResolvedValue([changed("a_b.toy", "run()\n")]);
    const summaries: string[] = [];
    await runAction({
      ...options,
      writeSummary: (markdown) => {
        summaries.push(markdown);
        return Promise.resolve();
      },
    });
    expect(summaries[0]).toContain("| a&#95;b.toy |");
  });
});

describe("runAction", () => {
  it("processes only PR paths, posts one COMMENT review, and never writes files", async () => {
    const { options, provider, github, workspace, maskSecret } = await fixture({
      "a.toy": "run()\n",
      "untouched.toy": "untouched()\n",
    });
    await runAction(options);
    expect(provider.requests).toHaveLength(1);
    expect(github.listFiles).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      pull_number: 3,
    });
    expect(github.createReview).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        event: "COMMENT",
        commit_id: sha,
        comments: [expect.objectContaining({ path: "a.toy", line: 1 })],
      }),
    );
    expect(maskSecret).toHaveBeenCalledWith("fake-test-key");
    expect(await readFile(join(workspace, "a.toy"), "utf8")).toBe("run()\n");
  });

  it("collects through nested ignores, info/exclude, config excludes and sensitive refusals", async () => {
    const files = {
      "a.toy": "run()\n",
      ".env.local": "PRIVATE",
      "id.pem": "PRIVATE",
      "id.key": "PRIVATE",
      "ignored.toy": "PRIVATE",
      "nested/private.toy": "PRIVATE",
      "local.toy": "PRIVATE",
      "excluded.toy": "PRIVATE",
    };
    const { options, provider, github, workspace } = await fixture(files);
    await writeFile(join(workspace, ".gitignore"), "ignored.toy\n");
    await writeFile(join(workspace, "nested/.gitignore"), "private.toy\n");
    await mkdir(join(workspace, ".git/info"));
    await writeFile(join(workspace, ".git/info/exclude"), "local.toy\n");
    await writeFile(
      join(workspace, ".whycoderc.json"),
      JSON.stringify({ exclude: ["excluded.toy"] }),
    );
    github.listFiles.mockResolvedValue(
      Object.entries(files).map(([path, code]) => changed(path, code)),
    );
    await runAction(options);
    expect(provider.requests).toHaveLength(1);
    expect(JSON.stringify(provider.requests)).not.toContain("PRIVATE");
    const review: unknown = github.createReview.mock.calls[0]?.[0];
    expect(JSON.stringify(review)).toContain("gitignore");
    expect(JSON.stringify(review)).toContain("never read");
  });

  it("skips removed paths and renamed files use the new name", async () => {
    const { options, github, provider } = await fixture();
    github.listFiles.mockResolvedValue([
      { ...changed("gone.toy", ""), status: "removed" },
      { ...changed("a.toy", "run()\n"), status: "renamed" },
    ]);
    await runAction(options);
    expect(provider.requests).toHaveLength(1);
    expect(JSON.stringify(github.createReview.mock.calls)).toContain("removed");
  });

  it("uses the environment key and respects comment-level input while forcing safe mode", async () => {
    const { options, provider, workspace, maskSecret } = await fixture();
    options.inputs = { commentLevel: "heavy" };
    options.env = { ANTHROPIC_API_KEY: "env-fake-key" };
    await writeFile(
      join(workspace, ".whycoderc.json"),
      JSON.stringify({
        mode: "refactor",
        testCommand: "never execute this",
        provider: "host",
      }),
    );
    await runAction(options);
    expect(maskSecret).toHaveBeenCalledWith("env-fake-key");
    expect(provider.requests[0]?.system).toContain("heavy");
    expect(provider.requests[0]?.system).not.toContain("refactor mode");
  });

  it("reports processing and verification failures without comments", async () => {
    const { options, github } = await fixture();
    options.provider = new FakeAIProvider(["bad", "bad"]);
    await runAction(options);
    expect(github.createReview.mock.calls[0]?.[0].comments).toEqual([]);
    expect(github.createReview.mock.calls[0]?.[0].body).toContain(
      "not processed",
    );
    const adapter = createToyAdapter();
    options.provider = new FakeAIProvider([
      commentPlanReply({
        insertions: [{ line: 1, position: "above", text: "unsafe" }],
      }),
    ]);
    options.adapters = [
      { ...adapter, tokens: (code) => Promise.resolve([code]) },
    ];
    await runAction(options);
    expect(github.createReview.mock.calls[1]?.[0].comments).toEqual([]);
    expect(github.createReview.mock.calls[1]?.[0].body).toContain(
      "verification failed",
    );
  });

  it("summarizes out-of-diff results, including missing patches", async () => {
    const { options, github } = await fixture();
    github.listFiles.mockResolvedValue([
      { ...changed("a.toy", "run()\n"), patch: undefined },
    ]);
    await runAction(options);
    expect(github.createReview.mock.calls[0]?.[0].comments).toEqual([]);
    expect(github.createReview.mock.calls[0]?.[0].body).toContain(
      "1 change(s) outside",
    );
  });

  it("posts nothing for a clean PR or a non-PR event", async () => {
    const { options, github } = await fixture();
    options.provider = new FakeAIProvider([commentPlanReply({})]);
    await runAction(options);
    expect(github.createReview).not.toHaveBeenCalled();
    options.eventName = "push";
    await runAction(options);
    expect(github.listFiles).toHaveBeenCalledTimes(1);
  });

  it("fails for missing keys, invalid inputs, and API errors", async () => {
    const { options, github } = await fixture();
    options.inputs = {};
    await expect(runAction(options)).rejects.toThrow("ANTHROPIC_API_KEY");
    options.inputs = { apiKey: "fake", commentLevel: "invalid" };
    await expect(runAction(options)).rejects.toThrow("configuration");
    options.inputs = { apiKey: "fake" };
    github.listFiles.mockRejectedValue(new Error("API unavailable"));
    await expect(runAction(options)).rejects.toThrow("API unavailable");
    github.listFiles.mockResolvedValue([changed("a.toy", "run()\n")]);
    github.createReview.mockRejectedValue(new Error("review failed"));
    await expect(runAction(options)).rejects.toThrow("review failed");
  });

  it("refuses mismatched checkouts, stale PRs, and dirty file contents", async () => {
    const { options, github, provider } = await fixture();
    options.readHead = () => Promise.resolve("wrong-head");
    await expect(runAction(options)).rejects.toThrow("PR head");
    options.readHead = () => Promise.resolve(sha);
    github.getHead.mockResolvedValue("new-head");
    await expect(runAction(options)).rejects.toThrow("PR head");
    expect(provider.requests).toEqual([]);
    github.getHead.mockResolvedValue(sha);
    github.listFiles.mockResolvedValue([changed("a.toy", "different()\n")]);
    await runAction(options);
    expect(provider.requests).toEqual([]);
    expect(JSON.stringify(github.createReview.mock.calls)).toContain(
      "does not match",
    );
  });

  it("does not post if the head advances during processing", async () => {
    const { options, github } = await fixture();
    github.getHead.mockResolvedValueOnce(sha).mockResolvedValueOnce("advanced");
    await expect(runAction(options)).rejects.toThrow("PR head");
    expect(github.createReview).not.toHaveBeenCalled();
  });

  it("never publishes literal API keys in suggestions or summary", async () => {
    const { options, github } = await fixture();
    options.provider = new FakeAIProvider([
      commentAboveFirstMatch(/run/, "fake-test-key"),
    ]);
    await runAction(options);
    expect(JSON.stringify(github.createReview.mock.calls)).not.toContain(
      "fake-test-key",
    );
    expect(JSON.stringify(github.createReview.mock.calls)).toContain("secret");
  });

  it("bounds review size and counts suggestions that do not fit", async () => {
    const files = Object.fromEntries(
      Array.from({ length: 51 }, (_, index) => [
        `file-${index}.toy`,
        "run()\n",
      ]),
    );
    const { options, github } = await fixture(files);
    options.provider = new FakeAIProvider(
      Array.from({ length: 51 }, () => commentAboveFirstMatch(/run/, "why")),
    );
    github.listFiles.mockResolvedValue(
      Object.entries(files).map(([path, code]) => changed(path, code)),
    );
    await runAction(options);
    expect(github.createReview.mock.calls[0]?.[0].comments).toHaveLength(50);
    expect(github.createReview.mock.calls[0]?.[0].body).toContain(
      "1 suggestion(s) withheld by review size limits",
    );
  });

  it("fails explicitly when the PR files endpoint reaches its cap", async () => {
    const { options, github, provider } = await fixture();
    github.listFiles.mockResolvedValue(
      Array.from({ length: 3000 }, (_, index) =>
        changed(`file-${index}.toy`, "run()\n"),
      ),
    );
    await expect(runAction(options)).rejects.toThrow("3,000-file limit");
    expect(provider.requests).toEqual([]);
    expect(github.createReview).not.toHaveBeenCalled();
  });

  it("reports non-UTF-8 reads without sending bytes to the provider", async () => {
    const { options, github, provider, workspace } = await fixture();
    await writeFile(join(workspace, "a.toy"), Buffer.from([0xff]));
    await runAction(options);
    expect(provider.requests).toEqual([]);
    expect(github.createReview.mock.calls[0]?.[0].body).toContain(
      "not valid UTF-8",
    );
  });
});
