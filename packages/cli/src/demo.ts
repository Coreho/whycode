// A prepared reply goes through the same parser, verification, preview and
// write path as a real run. Only a new temporary sample can be written.
import { defaultAdapters } from "@whycode/core";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFix } from "./fix.js";
import type { CliIo } from "./io.js";

export const DEMO_SOURCE = `export async function loadWithCleanup(load, cleanup) {
  try {
    return await load();
  } finally {
    cleanup();
  }
}
`;

export async function runDemo(io: CliIo): Promise<number> {
  io.stdout(
    "WhyCode demo — prepared response, simulated acceptance\nNo API key or model call. Your project files are not read or changed.\n\n",
  );
  const directory = await mkdtemp(join(tmpdir(), "whycode-demo-"));
  try {
    // Prevent project-root discovery from inheriting configuration above tmpdir.
    await mkdir(join(directory, ".git"));
    const sample = join(directory, "cleanup.js");
    await writeFile(sample, DEMO_SOURCE);
    io.stdout(
      `1. Original sample\n\n${DEMO_SOURCE}\n2. Preview and review\n\n`,
    );
    const demoIo: CliIo = {
      ...io,
      cwd: directory,
      env: {},
      interactive: true,
      ask: (question) => {
        io.stdout(`${question}y (simulated demo choice)\n`);
        return Promise.resolve("y");
      },
    };
    const exit = await runFix(
      ["cleanup.js"],
      {
        overrides: { mode: "safe", format: "never", model: "offline-demo" },
        yes: false,
      },
      demoIo,
      {
        adapters: defaultAdapters,
        concurrency: 1,
        createProvider: () => ({
          name: "prepared demo response (offline)",
          complete: () =>
            Promise.resolve(
              JSON.stringify({
                insertions: [
                  {
                    line: 5,
                    position: "above",
                    text: "If cleanup throws, its error replaces the load result or error.",
                  },
                ],
              }),
            ),
        }),
      },
    );
    if (exit !== 0) return exit;
    const result = await readFile(sample, "utf8");
    if (!result.includes("// If cleanup throws")) {
      throw new Error(
        "Demo comment was not applied; inspect the verification notes above.",
      );
    }
    io.stdout(
      `\n3. Result after simulated acceptance (temporary sample only)\n\n${result}\n`,
    );
    io.stdout(
      "The explanation points out a consequence of finally: a thrown cleanup error wins.\nThe token check preserves the checked code tokens; it does not establish comment truth.\nA live model may propose different comments or none.\n\nNext: configure your provider, then run whycode fix <one-file> --no-format.\nYou will review the proposal and choose whether to apply it yourself.\n",
    );
    return exit;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
