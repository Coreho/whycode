// Tests for running external formatter processes. Uses the current Node
// binary as a stand-in formatter so the tests work on every machine.
import { describe, expect, it } from "vitest";
import { runProcess } from "./process.js";

const node = process.execPath;

describe("runProcess", () => {
  it("passes stdin to the process and returns its stdout", async () => {
    const result = await runProcess(
      node,
      ["-e", "process.stdin.pipe(process.stdout)"],
      "héllo\n",
    );
    expect(result).toEqual({
      kind: "completed",
      exitCode: 0,
      stdout: "héllo\n",
      stderr: "",
    });
  });

  it("reports a failing exit code and stderr", async () => {
    const script = "process.stderr.write('bad input'); process.exit(3)";
    const result = await runProcess(node, ["-e", script], "");
    expect(result).toMatchObject({
      kind: "completed",
      exitCode: 3,
      stderr: "bad input",
    });
  });

  it('reports a missing command as "not-found" instead of throwing', async () => {
    const result = await runProcess("whycode-no-such-formatter", [], "");
    expect(result).toEqual({ kind: "not-found" });
  });
});
