// Builds the VS Code extension. esbuild bundles the extension, @whycode/core
// and every library they use into one CommonJS file, dist/extension.js; only
// the "vscode" module comes from VS Code itself. Next to it go the
// WebAssembly files tree-sitter needs (the web-tree-sitter.wasm runtime, and
// the grammars in dist/grammars) and the licenses of everything bundled.
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const extensionDir = fileURLToPath(new URL("..", import.meta.url));
const coreDir = join(extensionDir, "..", "core");
const distDir = join(extensionDir, "dist");
const requireFromCore = createRequire(join(coreDir, "package.json"));

/**
 * @param {string} dir
 * @returns {Promise<{ name?: string, license?: string, repository?: string | { url?: string }, dependencies?: Record<string, string> }>}
 */
async function readPackageJson(dir) {
  return JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
}

/** Copies every grammar .wasm file core depends on (with its license) into `target`. */
async function copyGrammars(/** @type {string} */ target) {
  await mkdir(target, { recursive: true });
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

/** web-tree-sitter looks for its runtime next to the bundle (see import-meta-url.js). */
async function copyTreeSitterRuntime(/** @type {string} */ target) {
  const wasm = requireFromCore.resolve("web-tree-sitter/web-tree-sitter.wasm");
  await copyFile(wasm, join(target, "web-tree-sitter.wasm"));
}

/**
 * Writes the license of every npm package in the bundle into one file, so
 * the .vsix carries the notices those licenses ask for.
 * @param {import("esbuild").Metafile} metafile
 * @param {string} target
 */
async function writeThirdPartyLicenses(metafile, target) {
  const packageDirs = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    const match = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input);
    if (match?.[1] !== undefined) packageDirs.add(join(extensionDir, match[1]));
  }
  const sections = [];
  for (const dir of [...packageDirs].sort()) {
    const name = (await readPackageJson(dir)).name ?? dir;
    sections.push(
      `${name}\n${"=".repeat(name.length)}\n\n${await licenseText(dir)}\n`,
    );
  }
  await writeFile(target, sections.join("\n\n"), "utf8");
}

/**
 * A package's license file plus any third-party notices it ships (Prettier
 * bundles its own dependencies), or what its package.json says when it has
 * no license file.
 */
async function licenseText(/** @type {string} */ dir) {
  const files = await readdir(dir);
  const notices = files
    .filter((file) => /^(licen[cs]e|third.?party)/i.test(file))
    .sort();
  if (notices.length > 0) {
    const texts = await Promise.all(
      notices.map((file) => readFile(join(dir, file), "utf8")),
    );
    return texts.map((text) => text.trim()).join("\n\n");
  }
  const { license, repository } = await readPackageJson(dir);
  if (license === undefined) throw new Error(`${dir} declares no license`);
  const url = typeof repository === "string" ? repository : repository?.url;
  return `License: ${license} (the package ships no license file${url ? `; see ${url}` : ""}).`;
}

await rm(distDir, { recursive: true, force: true });
const result = await build({
  entryPoints: [join(extensionDir, "src", "extension.ts")],
  outfile: join(distDir, "extension.js"),
  bundle: true,
  platform: "node",
  format: "cjs",
  // VS Code 1.95, the oldest version the extension supports, runs Node 20.
  target: "node20",
  external: ["vscode"],
  define: { "import.meta.url": "importMetaUrl" },
  inject: [join(extensionDir, "scripts", "import-meta-url.js")],
  metafile: true,
  logLevel: "warning",
});
await copyGrammars(join(distDir, "grammars"));
await copyTreeSitterRuntime(distDir);
await writeThirdPartyLicenses(
  result.metafile,
  join(distDir, "THIRD-PARTY-LICENSES.txt"),
);
