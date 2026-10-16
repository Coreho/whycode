// Tells whether a project has adopted a formatter, by looking for its
// configuration in the file's folder and every folder above it. WhyCode only
// runs a formatter a project uses, so it never reformats a whole codebase to
// a style nobody chose.
import { access, readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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
