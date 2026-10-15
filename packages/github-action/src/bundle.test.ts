// Exercises the release artifact outside the monorepo, with no real network or keys.
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("runs the standalone bundle with real grammars and fake API edges", async () => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [fileURLToPath(new URL("../scripts/verify-bundle.mjs", import.meta.url))],
    { timeout: 60000 },
  );
  expect(stdout).toContain("Standalone action verified");
}, 60000);
