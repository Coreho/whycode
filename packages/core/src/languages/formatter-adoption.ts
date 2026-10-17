// Tells whether a project has adopted a formatter, by looking for its
// configuration in the file's folder and every folder above it. WhyCode only
// runs a formatter a project uses, so it never reformats a whole codebase to
// a style nobody chose.
import { access, readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import * as prettier from "prettier";

/** True if `test` passes for the file's folder or any folder above it. */
async function inFolderOrAbove(
  filePath: string,
  test: (dir: string) => Promise<boolean>,
): Promise<boolean> {
  for (let dir = dirname(resolve(filePath)); ; dir = dirname(dir)) {
    if (await test(dir)) return true;
    if (dirname(dir) === dir || (await repositoryBoundary(dir))) return false;
  }
}

async function repositoryBoundary(dir: string): Promise<boolean> {
  try {
    await access(join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

/** Config discovery must not borrow style from outside a nested repository. */
export async function projectPrettierConfig(
  filePath: string,
): Promise<string | undefined> {
  const config = await prettier.resolveConfigFile(resolve(filePath));
  if (config === null) return undefined;
  return (await inFolderOrAbove(filePath, (dir) =>
    Promise.resolve(dir === dirname(config)),
  ))
    ? config
    : undefined;
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * True if any of the named files in `dir` exists and, when a pattern is
 * given, matches it. An empty config file still counts as adopting a tool.
 */
async function anyFileMatches(
  dir: string,
  names: readonly string[],
  pattern?: RegExp,
): Promise<boolean> {
  for (const name of names) {
    const text = await readOptional(join(dir, name));
    if (text !== undefined && (pattern === undefined || pattern.test(text))) {
      return true;
    }
  }
  return false;
}

/**
 * A Prettier config (a .prettierrc file, prettier.config.js, or a "prettier"
 * key in package.json), or Prettier as a dependency used with its defaults.
 */
export async function prettierAdopted(filePath: string): Promise<boolean> {
  // Validate manifests even when Prettier itself discovers a package config.
  const dependency = await inFolderOrAbove(filePath, async (dir) => {
    const text = await readOptional(join(dir, "package.json"));
    if (text === undefined) return false;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error(`invalid package.json in ${dir}`);
    }
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return false;
    const manifest = value as Record<string, unknown>;
    return [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ].some((key) => {
      const section = manifest[key];
      return (
        typeof section === "object" &&
        section !== null &&
        "prettier" in section &&
        typeof section.prettier === "string" &&
        section.prettier.length > 0
      );
    });
  });
  return dependency || (await projectPrettierConfig(filePath)) !== undefined;
}

/**
 * The .prettierignore that tells Prettier to leave the file alone, if any.
 * Every .prettierignore between the file and the repository root counts,
 * each with its patterns read relative to its own folder.
 */
export async function prettierIgnoreFor(
  filePath: string,
): Promise<string | undefined> {
  const ignoreFiles: string[] = [];
  await inFolderOrAbove(filePath, async (dir) => {
    const ignoreFile = join(dir, ".prettierignore");
    if ((await readOptional(ignoreFile)) !== undefined) {
      ignoreFiles.push(ignoreFile);
    }
    return false;
  });
  for (const ignorePath of ignoreFiles) {
    // resolveConfig: false, or Prettier loads the project's config, which runs
    // a JavaScript config file.
    const info = await prettier.getFileInfo(resolve(filePath), {
      ignorePath,
      resolveConfig: false,
    });
    if (info.ignored) return ignorePath;
  }
  return undefined;
}

// Prettier runs a config written in JavaScript or TypeScript.
const CODE_CONFIG = /\.[cm]?[jt]s$/;

/**
 * Why formatting with the project's Prettier config would run code from the
 * project, or undefined if it wouldn't. Prettier runs a JavaScript config,
 * loads the plugins a config names, and loads a shared config package that a
 * config points to by name. Checked without asking Prettier, which would
 * run the config to find out.
 */
export async function prettierConfigRunsCode(
  filePath: string,
): Promise<string | undefined> {
  const config = await projectPrettierConfig(filePath);
  if (config === undefined) return undefined;
  const name = basename(config);
  if (CODE_CONFIG.test(name)) {
    return `the project's ${name} is JavaScript, which Prettier would run`;
  }
  const text = (await readOptional(config)) ?? "";
  const settings = name === "package.json" ? packagePrettierKey(text) : text;
  if (settings === undefined) return undefined;
  // Conservative on purpose: a false alarm only skips formatting with a note.
  if (/\bplugins\b/.test(settings)) {
    return `the project's ${name} names Prettier plugins, which Prettier would run`;
  }
  if (namesSharedConfig(settings)) {
    return `the project's ${name} points to a shared Prettier config package, which Prettier would run`;
  }
  return undefined;
}

/** The "prettier" key of a package.json, as JSON text, if there is one. */
function packagePrettierKey(text: string): string | undefined {
  try {
    const manifest: unknown = JSON.parse(text);
    if (typeof manifest !== "object" || manifest === null) return undefined;
    const value: unknown = (manifest as Record<string, unknown>).prettier;
    return value === undefined ? undefined : JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/**
 * True if config text is a bare name rather than settings: a JSON string or
 * a YAML scalar such as "@company/prettier-config".
 */
function namesSharedConfig(text: string): boolean {
  const content = text
    .split("\n")
    .filter((line) => !/^\s*(#|\/\/)/.test(line))
    .join("\n")
    .trim();
  if (content === "") return false;
  try {
    // JSON: a string names a package; an object (even {}) holds settings.
    return typeof JSON.parse(content) === "string";
  } catch {
    // YAML or TOML: settings need ":" or "=", a bare name has neither.
    return !content.includes(":") && !content.includes("=");
  }
}

/** Only Ruff settings opt into Ruff; Black preferences are not translated. */
export function ruffAdopted(filePath: string): Promise<boolean> {
  return inFolderOrAbove(
    filePath,
    async (dir) =>
      (await anyFileMatches(dir, ["ruff.toml", ".ruff.toml"])) ||
      (await anyFileMatches(
        dir,
        ["pyproject.toml"],
        /^\s*\[tool\.ruff(?:\.|\])/m,
      )),
  );
}

/** A CSharpier config file, tool manifest entry, or MSBuild package. */
export function csharpierAdopted(filePath: string): Promise<boolean> {
  return inFolderOrAbove(filePath, async (dir) => {
    const configs = [
      ".csharpierrc",
      ".csharpierrc.json",
      ".csharpierrc.yaml",
      ".csharpierrc.yml",
    ];
    if (await anyFileMatches(dir, configs)) return true;
    const builds = [
      join(".config", "dotnet-tools.json"),
      "Directory.Build.props",
      ...(await projectFiles(dir)),
    ];
    return anyFileMatches(dir, builds, /csharpier/i);
  });
}

/** google-java-format configured in the Gradle or Maven build (e.g. Spotless). */
export function googleJavaFormatAdopted(filePath: string): Promise<boolean> {
  return inFolderOrAbove(filePath, (dir) =>
    anyFileMatches(
      dir,
      ["build.gradle", "build.gradle.kts", "pom.xml"],
      /google-?java-?format|googleJavaFormat/i,
    ),
  );
}

async function projectFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((name) => name.endsWith(".csproj"));
  } catch {
    return [];
  }
}
