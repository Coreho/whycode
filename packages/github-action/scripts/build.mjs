// Bundles all JavaScript dependencies and ships grammar/runtime WASM plus licenses.
import { copyFile, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const actionDir = fileURLToPath(new URL("..", import.meta.url));
const coreDir = join(actionDir, "..", "core");
const distDir = join(actionDir, "dist");
const fromCore = createRequire(join(coreDir, "package.json"));
const manifest = /** @type {{ dependencies: Record<string, string> }} */ (
  JSON.parse(await readFile(join(coreDir, "package.json"), "utf8"))
);

await rm(distDir, { recursive: true, force: true });
await build({
  entryPoints: {
    index: join(actionDir, "src/index.ts"),
    internal: join(actionDir, "src/internal.ts"),
  },
  outdir: distDir,
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22.12",
  // Bundled ESM dependencies locate their WASM/plugins beside this CJS file.
  define: { "import.meta.url": "__bundleUrl" },
  banner: {
    js: 'const __bundleUrl = require("node:url").pathToFileURL(__filename).href;',
  },
  logLevel: "warning",
});

const grammars = join(distDir, "grammars");
await mkdir(grammars, { recursive: true });
for (const name of Object.keys(manifest.dependencies).filter((name) =>
  name.startsWith("tree-sitter-"),
)) {
  const directory = dirname(fromCore.resolve(`${name}/package.json`));
  for (const file of (await readdir(directory)).filter((file) =>
    file.endsWith(".wasm"),
  )) {
    await copyFile(join(directory, file), join(grammars, file));
  }
  await copyFile(join(directory, "LICENSE"), join(grammars, `${name}.LICENSE`));
}
await copyFile(
  fromCore.resolve("web-tree-sitter/web-tree-sitter.wasm"),
  join(distDir, "web-tree-sitter.wasm"),
);
// Prettier resolves its built-in parsers dynamically; ship those modules too.
const prettierDir = dirname(fromCore.resolve("prettier/package.json"));
await mkdir(join(distDir, "plugins"));
for (const file of (await readdir(join(prettierDir, "plugins"))).filter(
  (file) => file.endsWith(".mjs"),
)) {
  await copyFile(
    join(prettierDir, "plugins", file),
    join(distDir, "plugins", file),
  );
}
await copyFile(join(prettierDir, "LICENSE"), join(distDir, "prettier.LICENSE"));
