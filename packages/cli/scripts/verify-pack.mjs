// Checks the package the way a user gets it: packs it (pnpm pack turns the
// workspace:* dev dependency into a version, as pnpm publish would), lists
// what the tarball contains, installs it globally into a throwaway folder and
// checks version, help, the offline demo, and the agent workflow from there.
// Run after `pnpm build`, or pass an existing tarball as the first argument;
// it needs network access to install the dependencies.
import { execSync } from "node:child_process";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const cliDir = fileURLToPath(new URL("..", import.meta.url));
const work = await mkdtemp(join(tmpdir(), "whycode-pack-"));

/** Runs a shell command and returns its output. */
function run(/** @type {string} */ command, /** @type {string} */ cwd) {
  return execSync(command, { cwd, encoding: "utf8", stdio: "pipe" });
}

try {
  if (!process.argv[2]) run(`pnpm pack --pack-destination "${work}"`, cliDir);
  const tarball = process.argv[2]
    ? resolve(process.argv[2])
    : (await readdir(work)).find((file) => file.endsWith(".tgz"));
  if (tarball === undefined) throw new Error("pnpm pack made no tarball");
  const archive = resolve(work, tarball);
  console.log(`Contents of ${tarball}:`);
  const contents = run(`tar -tzf "${archive}"`, work);
  console.log(contents);
  for (const entry of contents.trim().split(/\r?\n/)) {
    assert.match(
      entry,
      /^package\/(dist\/|package\.json$|README\.md$|LICENSE$)/,
    );
  }

  const prefix = join(work, "global");
  run(`npm install --global --prefix "${prefix}" "${archive}"`, work);
  const bin =
    process.platform === "win32"
      ? join(prefix, "whycode.cmd")
      : join(prefix, "bin", "whycode");
  console.log(`whycode --version: ${run(`"${bin}" --version`, work).trim()}`);
  const help = run(`"${bin}" --help`, work);
  console.log(`whycode --help: ${help.split("\n")[0]}`);
  assert.match(help, /preview/);
  const demo = run(`"${bin}" demo`, work);
  assert.match(demo, /Wrote cleanup\.js/);
  assert.match(demo, /preserved the checked code tokens/);
  const sample = join(work, "sample");
  await mkdir(join(sample, ".git"), { recursive: true });
  const source = "export const ready = true;\n";
  await writeFile(join(sample, "sample.js"), source);
  await writeFile(
    join(sample, "plan.json"),
    JSON.stringify({
      insertions: [
        {
          line: 1,
          position: "above",
          text: "Prepared package smoke-test comment.",
        },
      ],
    }),
  );
  assert.match(
    run(`"${bin}" prompt sample.js --no-format`, sample),
    /REPLY SCHEMA/,
  );
  const preview = run(
    `"${bin}" preview sample.js --plan plan.json --no-format`,
    sample,
  );
  const fingerprint = /Fingerprint: ([a-f0-9]{64})/.exec(preview)?.[1];
  assert.ok(fingerprint, "preview returned a fingerprint");
  assert.equal(await readFile(join(sample, "sample.js"), "utf8"), source);
  run(
    `"${bin}" write sample.js --plan plan.json --fingerprint ${fingerprint} --no-format`,
    sample,
  );
  assert.match(
    await readFile(join(sample, "sample.js"), "utf8"),
    /Prepared package smoke-test comment/,
  );
  console.log(
    "Installed package passed help, offline demo, prompt, preview, and write checks.",
  );
} finally {
  await rm(work, { recursive: true, force: true });
}
