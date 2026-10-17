import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runCli } from "./cli.js";
import type { CliIo } from "./io.js";
import { parseCommandLine } from "./args.js";

it("demonstrates real JS verification and writes only its temporary sample without a provider", async () => {
  const directory = await mkdtemp(join(tmpdir(), "whycode-demo-test-"));
  try {
    await mkdir(join(directory, ".git"));
    await writeFile(join(directory, "cleanup.js"), "user code\n");
    // The demo must not load even malformed caller configuration.
    await writeFile(join(directory, ".whycoderc.json"), "invalid json");
    let output = "";
    const io: CliIo = {
      cwd: directory,
      env: {},
      stdout: (text) => {
        output += text;
      },
      stderr: (text) => {
        output += text;
      },
      color: false,
      interactive: false,
      ask: () => {
        throw new Error("Demo must label and simulate its own choice");
      },
      readStdin: () => {
        throw new Error("No input needed");
      },
    };
    expect(
      await runCli(["demo"], io, {
        adapters: [],
        concurrency: 1,
        createProvider: () => {
          throw new Error("No configured provider allowed");
        },
      }),
    ).toBe(0);
    expect(output).toContain("prepared response, simulated acceptance");
    expect(output).toContain("Preview · Nothing written to this file");
    expect(output).toContain(
      "Checks: new comment edits preserved the checked code tokens.",
    );
    expect(output).toContain("y (simulated demo choice)");
    expect(output).toContain("Wrote cleanup.js");
    expect(output).toContain("3. Result after simulated acceptance");
    expect(output).toContain(
      "// If cleanup throws, its error replaces the load result or error.",
    );
    expect(await readFile(join(directory, "cleanup.js"), "utf8")).toBe(
      "user code\n",
    );
    expect((await readdir(directory)).sort()).toEqual([
      ".git",
      ".whycoderc.json",
      "cleanup.js",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("refuses paths and write flags for the demonstration", () => {
  expect(parseCommandLine(["demo", "src"])).toMatchObject({ kind: "error" });
  expect(parseCommandLine(["demo", "--yes"])).toMatchObject({ kind: "error" });
});
