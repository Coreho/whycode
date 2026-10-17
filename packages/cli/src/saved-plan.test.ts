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
  it("never stores or accepts trust in a plan file", async () => {
    expect(
      await run(
        "check",
        "a.toy",
        "--trust-formatter-config",
        "--save-plan",
        "review.json",
      ),
    ).toBe(1);
    const plan = JSON.parse(
      await readFile(join(root, "review.json"), "utf8"),
    ) as { overrides: Record<string, unknown> };
    expect(plan.overrides).not.toHaveProperty("trustFormatterConfig");
    // Replaying needs the flag again, so the config matches the saved one.
    expect(
      await run(
        "fix",
        "--plan",
        "review.json",
        "--yes",
        "--trust-formatter-config",
      ),
    ).toBe(0);

    plan.overrides.trustFormatterConfig = true;
    await writeFile(join(root, "forged.json"), JSON.stringify(plan));
    expect(await run("fix", "--plan", "forged.json", "--yes")).toBe(2);
    expect(stderr).toContain(
      "A saved plan can't grant --trust-formatter-config",
    );
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

  it("masks likely secrets in the suggestions it remembers", async () => {
    const token = `ghp_${"a1".repeat(18)}`;
    await writeFile(join(root, "a.toy"), "# Wrong.\nrun\n");
    response = commentPlanReply({
      insertions: [{ line: 2, position: "above", text: "Begin." }],
      existingCommentSuggestions: [
        {
          line: 1,
          original: "Wrong.",
          suggested: `Uses ${token}.`,
          reason: `Mentions ${token}.`,
        },
      ],
    });
    expect(
      await run("fix", "a.toy", "--yes", "--review-state", "state.json"),
    ).toBe(0);
    const state = await readFile(join(root, "state.json"), "utf8");
    expect(state).toContain("Uses [REDACTED].");
    expect(state).not.toContain(token);
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

  const correction = {
    line: 1,
    original: "Wrong.",
    suggested: "Correct.",
    reason: "Incorrect explanation.",
  };
  async function rejectCorrection() {
    expect(
      await runCli(
        ["fix", "a.toy", "--review-state", "state.json"],
        { ...io(), interactive: true, ask: () => Promise.resolve("n") },
        deps,
      ),
    ).toBe(0);
  }

  it("withholds rejected rewrites on repeated fresh checks and fixes, including config changes", async () => {
    await writeFile(join(root, "a.toy"), "# Wrong.\nrun\n");
    response = commentPlanReply({ existingCommentSuggestions: [correction] });
    await rejectCorrection();
    for (const command of ["check", "fix", "check"]) {
      stdout = "";
      expect(
        await run(
          command,
          "a.toy",
          "--review-state",
          "state.json",
          "--refresh",
          ...(command === "fix" ? ["--yes"] : []),
        ),
      ).toBe(0);
      expect(stdout).toContain(
        "Withheld 1 previously rejected comment suggestion",
      );
      expect(stdout).not.toContain("Correct.");
    }
    expect(calls).toBe(4);
    await writeFile(join(root, ".whycoderc.json"), '{"commentLevel":"heavy"}');
    stdout = "";
    expect(await run("check", "a.toy", "--review-state", "state.json")).toBe(0);
    expect(calls).toBe(5);
    expect(stdout).toContain("Withheld 1");
  });

  it("regenerates after a build change while preserving rejected rewrites", async () => {
    await writeFile(join(root, "a.toy"), "# Wrong.\nrun\n");
    response = commentPlanReply({ existingCommentSuggestions: [correction] });
    await rejectCorrection();
    const path = join(root, "state.json");
    const state = JSON.parse(await readFile(path, "utf8")) as { tool: string };
    state.tool = "previous-build";
    await writeFile(path, JSON.stringify(state));
    stdout = "";
    expect(
      await run("fix", "a.toy", "--review-state", "state.json", "--yes"),
    ).toBe(0);
    expect(calls).toBe(2);
    expect(stdout).toContain("Withheld 1");
    stdout = "";
    expect(
      await run("check", "a.toy", "--review-state", "state.json", "--refresh"),
    ).toBe(0);
    expect(stdout).toContain("Withheld 1");
  });

  it("allows a different replacement and resets rejections when source changes", async () => {
    await writeFile(join(root, "a.toy"), "# Wrong.\nrun\n");
    response = commentPlanReply({ existingCommentSuggestions: [correction] });
    await rejectCorrection();
    response = commentPlanReply({
      existingCommentSuggestions: [
        { ...correction, suggested: "Different correction." },
      ],
    });
    stdout = "";
    expect(
      await run("check", "a.toy", "--review-state", "state.json", "--refresh"),
    ).toBe(0);
    expect(stdout).toContain("Different correction.");
    response = commentPlanReply({ existingCommentSuggestions: [correction] });
    await writeFile(join(root, "a.toy"), "# Wrong.\nchanged\n");
    stdout = "";
    expect(
      await run("fix", "a.toy", "--review-state", "state.json", "--yes"),
    ).toBe(0);
    expect(stdout).toContain("Not applied: 1");
    stdout = "";
    expect(
      await run("check", "a.toy", "--review-state", "state.json", "--refresh"),
    ).toBe(0);
    expect(stdout).toContain("Correct.");
    expect(stdout).not.toContain("Withheld");
  });

  it.each([false, true])(
    "normalizes secrets when rejection comes from cached review: %s",
    async (cached) => {
      const token = `ghp_${"a1".repeat(18)}`;
      await writeFile(join(root, "a.toy"), "# Wrong.\nrun\n");
      response = commentPlanReply({
        existingCommentSuggestions: [
          { ...correction, suggested: `Uses ${token}.` },
        ],
      });
      if (cached)
        expect(
          await run("fix", "a.toy", "--review-state", "state.json", "--yes"),
        ).toBe(0);
      await rejectCorrection();
      stdout = "";
      expect(
        await run(
          "check",
          "a.toy",
          "--review-state",
          "state.json",
          "--refresh",
        ),
      ).toBe(0);
      expect(stdout).toContain("Withheld 1");
      expect(stdout).not.toContain("Uses ");
      expect(await readFile(join(root, "state.json"), "utf8")).not.toContain(
        token,
      );
    },
  );

  it("matches rejections when new insertions move suggestion lines", async () => {
    await writeFile(join(root, "a.toy"), "run\n# Wrong.\nfinish\n");
    response = commentPlanReply({
      existingCommentSuggestions: [{ ...correction, line: 2 }],
    });
    await rejectCorrection();
    response = commentPlanReply({
      insertions: [{ line: 1, position: "above", text: "Begin." }],
      existingCommentSuggestions: [{ ...correction, line: 2 }],
    });
    stdout = "";
    expect(
      await run("check", "a.toy", "--review-state", "state.json", "--refresh"),
    ).toBe(1);
    expect(stdout).toContain("Withheld 1");
    expect(stdout).not.toContain("Correct.");
  });

  it("does not suppress identical rewrites at a different source location", async () => {
    await writeFile(join(root, "a.toy"), "# Wrong.\nrun\n# Wrong.\nfinish\n");
    response = commentPlanReply({ existingCommentSuggestions: [correction] });
    await rejectCorrection();
    response = commentPlanReply({
      existingCommentSuggestions: [correction, { ...correction, line: 3 }],
    });
    stdout = "";
    expect(
      await run("check", "a.toy", "--review-state", "state.json", "--refresh"),
    ).toBe(0);
    expect(stdout).toContain("Withheld 1");
    expect(stdout).toContain("Correct.");
  });

  it("anchors a rejection after an accepted rewrite moves its comment", async () => {
    await writeFile(join(root, "a.toy"), "# Heading.\nrun\n# Wrong.\nfinish\n");
    response = commentPlanReply({
      existingCommentSuggestions: [
        { ...correction, original: "Heading.", suggested: "First.\nSecond." },
        { ...correction, line: 3 },
      ],
    });
    const answers = ["y", "n"];
    expect(
      await runCli(
        ["fix", "a.toy", "--review-state", "state.json"],
        {
          ...io(),
          interactive: true,
          ask: () => Promise.resolve(answers.shift()),
        },
        deps,
      ),
    ).toBe(0);
    expect(await readFile(join(root, "a.toy"), "utf8")).toBe(
      "# First.\n# Second.\nrun\n# Wrong.\nfinish\n",
    );
    response = commentPlanReply({
      existingCommentSuggestions: [{ ...correction, line: 4 }],
    });
    stdout = "";
    expect(
      await run("check", "a.toy", "--review-state", "state.json", "--refresh"),
    ).toBe(0);
    expect(stdout).toContain("Withheld 1");
    expect(stdout).not.toContain("Correct.");
  });
});
