import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commentPlanReply,
  createToyAdapter,
  numberedLines,
} from "@whycode/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "./cli.js";
import type { CliIo } from "./io.js";
import type { CommandDeps } from "./run.js";

describe("saved reviews", () => {
  let root: string, stdout: string, stderr: string, calls: number;
  const code = "run SOURCE_ONLY_CANARY\n";
  const reply = commentPlanReply({
    insertions: [{ line: 1, position: "above", text: "Begin." }],
  });
  let response = reply;
  const deps: CommandDeps = {
    adapters: [createToyAdapter()],
    concurrency: 1,
    createProvider: () => ({
      name: "test",
      complete: (request) => {
        calls++;
        // Like a real model, comment the first line of code, never a comment.
        if (response !== reply) return Promise.resolve(response);
        const target = numberedLines(request).find(
          (line) => !line.text.startsWith("#"),
        );
        return Promise.resolve(
          commentPlanReply({
            insertions: [
              { line: target?.number ?? 1, position: "above", text: "Begin." },
            ],
          }),
        );
      },
    }),
  };
  const io = (): CliIo => ({
    cwd: root,
    env: {},
    color: false,
    interactive: false,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    ask: () => Promise.resolve(undefined),
    readStdin: () => Promise.resolve(""),
  });
  const run = (...args: string[]) => runCli(args, io(), deps);
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "whycode-saved-"));
    await mkdir(join(root, ".git"));
    await writeFile(join(root, "a.toy"), code);
    stdout = "";
    stderr = "";
    calls = 0;
    response = reply;
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  async function save() {
    expect(await run("check", "a.toy", "--save-plan", "review.json")).toBe(1);
    expect(calls).toBe(1);
  }
  it("applies exactly the saved diff with no provider creation and no source snapshot", async () => {
    await save();
    const saved = await readFile(join(root, "review.json"), "utf8");
    expect(saved).not.toContain("SOURCE_ONLY_CANARY");
    const before = stdout;
    stdout = "";
    expect(
      await runCli(["fix", "--plan", "review.json", "--yes"], io(), {
        ...deps,
        createProvider: () => {
          throw new Error("must remain offline");
        },
      }),
    ).toBe(0);
    expect(await readFile(join(root, "a.toy"), "utf8")).toBe(
      "# Begin.\n" + code,
    );
    expect(before).toContain("+# Begin.");
    expect(stdout).toContain("+# Begin.");
    expect(calls).toBe(1);
  });
  it("refuses changed source without regeneration or writes", async () => {
    await save();
    await writeFile(join(root, "a.toy"), "other\n");
    expect(await run("fix", "--plan", "review.json", "--yes")).toBe(2);
    expect(await readFile(join(root, "a.toy"), "utf8")).toBe("other\n");
    expect(stderr).toMatch(/source.*changed|changed.*source/i);
    expect(calls).toBe(1);
  });
  it("refuses configuration drift", async () => {
    await save();
    await writeFile(join(root, ".whycoderc.json"), '{"commentLevel":"heavy"}');
    expect(await run("fix", "--plan", "review.json", "--yes")).toBe(2);
    expect(await readFile(join(root, "a.toy"), "utf8")).toBe(code);
    expect(stderr).toMatch(/config/i);
    expect(calls).toBe(1);
  });
  it("refuses an edited reply with the original fingerprint", async () => {
    await save();
    const path = join(root, "review.json");
    await writeFile(
      path,
      (await readFile(path, "utf8")).replace("Begin.", "Different."),
    );
    expect(await run("fix", "--plan", "review.json", "--yes")).toBe(2);
    expect(await readFile(join(root, "a.toy"), "utf8")).toBe(code);
    expect(calls).toBe(1);
  });
  it("does not overwrite an existing plan or source file", async () => {
    expect(await run("check", "a.toy", "--save-plan", "a.toy")).toBe(2);
    expect(await readFile(join(root, "a.toy"), "utf8")).toBe(code);
  });
  it("carries explicit format overrides from check into offline fix", async () => {
    await writeFile(join(root, ".whycoderc.json"), '{"format":"always"}');
    expect(
      await run("check", "a.toy", "--no-format", "--save-plan", "review.json"),
    ).toBe(1);
    expect(await run("fix", "--plan", "review.json", "--yes")).toBe(0);
    expect(calls).toBe(1);
  });

  it("reuses the post-fix review for check and fix without creating a provider", async () => {
    expect(
      await run("fix", "a.toy", "--yes", "--review-state", "state.json"),
    ).toBe(0);
    const cleaned = await readFile(join(root, "a.toy"), "utf8");
    const offline = {
      ...deps,
      createProvider: () => {
        throw new Error("must remain offline");
      },
    };
    for (const command of ["check", "fix"]) {
      expect(
        await runCli(
          [
            command,
            "a.toy",
            "--review-state",
            "state.json",
            ...(command === "fix" ? ["--yes"] : []),
          ],
          io(),
          offline,
        ),
      ).toBe(0);
    }
    expect(await readFile(join(root, "a.toy"), "utf8")).toBe(cleaned);
    expect(await readFile(join(root, "state.json"), "utf8")).not.toContain(
      "SOURCE_ONLY_CANARY",
    );
    expect(calls).toBe(1);
    expect(stdout).toMatch(/saved review/i);
  });

  it("invalidates remembered reviews on source/config changes and explicit refresh", async () => {
    expect(
      await run("fix", "a.toy", "--yes", "--review-state", "state.json"),
    ).toBe(0);
    expect(
      await run("check", "a.toy", "--review-state", "state.json", "--refresh"),
    ).toBe(1);
    expect(calls).toBe(2);
    await writeFile(join(root, "a.toy"), "different\n");
    expect(
      await run("fix", "a.toy", "--yes", "--review-state", "state.json"),
    ).toBe(0);
    expect(calls).toBe(3);
    await writeFile(join(root, ".whycoderc.json"), '{"commentLevel":"heavy"}');
    expect(await run("check", "a.toy", "--review-state", "state.json")).toBe(1);
    expect(calls).toBe(4);
  });

  it("keeps pending corrections visible, remembers rejection, and never silently applies them", async () => {
    await writeFile(join(root, "a.toy"), "# Wrong.\nrun\n");
    response = commentPlanReply({
      insertions: [{ line: 2, position: "above", text: "Begin." }],
      existingCommentSuggestions: [
        {
          line: 1,
          original: "Wrong.",
          suggested: "Correct.",
          reason: "Incorrect explanation.",
        },
      ],
    });
    expect(
      await run("fix", "a.toy", "--yes", "--review-state", "state.json"),
    ).toBe(0);
    stdout = "";
    expect(await run("check", "a.toy", "--review-state", "state.json")).toBe(0);
    expect(stdout).toContain("Correct.");
    expect(await readFile(join(root, "a.toy"), "utf8")).toContain("# Wrong.");
    expect(calls).toBe(1);
    expect(
      await runCli(
        ["fix", "a.toy", "--review-state", "state.json"],
        { ...io(), interactive: true, ask: () => Promise.resolve("n") },
        deps,
      ),
    ).toBe(0);
    stdout = "";
    expect(await run("check", "a.toy", "--review-state", "state.json")).toBe(0);
    expect(stdout).not.toContain("Correct.");
    expect(calls).toBe(1);
  });

  it("can remember a saved-plan application and then check it offline", async () => {
    await save();
    expect(
      await run(
        "fix",
        "--plan",
        "review.json",
        "--review-state",
        "state.json",
        "--yes",
      ),
    ).toBe(0);
    expect(await run("check", "a.toy", "--review-state", "state.json")).toBe(0);
    expect(calls).toBe(1);
  });
});
