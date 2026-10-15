// Checks the package the way a user gets it: packs it (pnpm pack turns the
// workspace:* dev dependency into a version, as pnpm publish would), lists
// what the tarball contains, installs it globally into a throwaway folder and
// runs `whycode --version` and `whycode --help` from there. Run after
// `pnpm build`; it needs network access to install the dependencies.
import { execSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cliDir = fileURLToPath(new URL("..", import.meta.url));
const work = await mkdtemp(join(tmpdir(), "whycode-pack-"));

/** Runs a shell command and returns its output. */
function run(/** @type {string} */ command, /** @type {string} */ cwd) {
  return execSync(command, { cwd, encoding: "utf8", stdio: "pipe" });
}

try {
  run(`pnpm pack --pack-destination "${work}"`, cliDir);
  const tarball = (await readdir(work)).find((file) => file.endsWith(".tgz"));
  if (tarball === undefined) throw new Error("pnpm pack made no tarball");
  console.log(`Contents of ${tarball}:`);
  console.log(run(`tar -tzf "${tarball}"`, work));

  const prefix = join(work, "global");
  run(
    `npm install --global --prefix "${prefix}" "${join(work, tarball)}"`,
    work,
  );
  const bin =
    process.platform === "win32"
      ? join(prefix, "whycode.cmd")
      : join(prefix, "bin", "whycode");
  console.log(`whycode --version: ${run(`"${bin}" --version`, work).trim()}`);
  const help = run(`"${bin}" --help`, work);
  console.log(`whycode --help: ${help.split("\n")[0]}`);
} finally {
  await rm(work, { recursive: true, force: true });
}
