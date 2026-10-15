// Builds the publishable CLI. esbuild bundles the CLI and @whycode/core into
// dist/bin.js; core's npm dependencies stay ordinary dependencies of the
// package. The tree-sitter grammars' .wasm files (with their licenses) are
// copied into dist/grammars, so installing WhyCode never runs a grammar
// package's install script, which tries to compile native code.
import { copyFile, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const cliDir = fileURLToPath(new URL("..", import.meta.url));
const coreDir = join(cliDir, "..", "core");
const distDir = join(cliDir, "dist");

/** @param {string} path @returns {Promise<{ dependencies?: Record<string, string> }>} */
async function readPackageJson(path) {
  return JSON.parse(await readFile(join(path, "package.json"), "utf8"));
}

/** Copies every grammar .wasm file that core depends on into `target`. */
async function copyGrammars(/** @type {string} */ target) {
  await mkdir(target, { recursive: true });
  const requireFromCore = createRequire(join(coreDir, "package.json"));
  const corePackage = await readPackageJson(coreDir);
  const grammarPackages = Object.keys(corePackage.dependencies ?? {}).filter(
    (name) => name.startsWith("tree-sitter-"),
  );
  for (const name of grammarPackages) {
    const packageDir = dirname(requireFromCore.resolve(`${name}/package.json`));
    const files = await readdir(packageDir);
    for (const file of files.filter((file) => file.endsWith(".wasm"))) {
      await copyFile(join(packageDir, file), join(target, file));
    }
    await copyFile(
      join(packageDir, "LICENSE"),
      join(target, `${name}.LICENSE`),
    );
  }
}

const cliPackage = await readPackageJson(cliDir);
await rm(distDir, { recursive: true, force: true });
await build({
  entryPoints: [join(cliDir, "src", "bin.ts")],
  outfile: join(distDir, "bin.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22.12",
  // Everything the package installs stays external; @whycode/core is a
  // devDependency, so it is bundled.
  external: Object.keys(cliPackage.dependencies ?? {}),
  logLevel: "warning",
});
await copyGrammars(join(distDir, "grammars"));
