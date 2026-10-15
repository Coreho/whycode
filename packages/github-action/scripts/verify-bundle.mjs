// Copies the release to a fresh temp repo and runs it without workspace/node_modules access.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const actionDir = fileURLToPath(new URL("..", import.meta.url));
const temp = await mkdtemp(join(tmpdir(), "whycode-standalone-action-"));
try {
  await cp(join(actionDir, "dist"), join(temp, "dist"), { recursive: true });
  await cp(
    join(actionDir, "scripts/standalone-smoke.mjs"),
    join(temp, "smoke.mjs"),
  );
  await promisify(execFile)("git", ["init", "--quiet", temp]);
  const eventPath = join(temp, "event.json");
  await writeFile(
    eventPath,
    JSON.stringify({
      pull_request: { number: 1, head: { sha: "offline-head" } },
    }),
  );
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [join(temp, "smoke.mjs")],
    {
      cwd: temp,
      env: {
        ...process.env,
        NODE_PATH: "",
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_REPOSITORY: "offline/repo",
        GITHUB_WORKSPACE: temp,
      },
      timeout: 60000,
    },
  );
  assert.match(stdout, /Standalone action verified/);
  process.stdout.write(stdout);
} finally {
  await rm(temp, { recursive: true, force: true });
}
