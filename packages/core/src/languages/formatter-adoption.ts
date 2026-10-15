// Tells whether a project has adopted a formatter, by looking for its
// configuration in the file's folder and every folder above it. WhyCode only
// runs a formatter a project uses, so it never reformats a whole codebase to
// a style nobody chose.
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import * as prettier from "prettier";

/** True if `test` passes for the file's folder or any folder above it. */
async function inFolderOrAbove(
  filePath: string,
  test: (dir: string) => Promise<boolean>,
): Promise<boolean> {
  for (let dir = dirname(resolve(filePath)); ; dir = dirname(dir)) {
    if (await test(dir)) return true;
    if (dirname(dir) === dir) return false;
  }
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
  if ((await prettier.resolveConfigFile(resolve(filePath))) !== null) {
    return true;
  }
  return inFolderOrAbove(filePath, (dir) =>
    anyFileMatches(dir, ["package.json"], /"prettier"\s*:/),
  );
}

/** Ruff or Black settings: Ruff's format is Black-compatible. */
export function ruffAdopted(filePath: string): Promise<boolean> {
  return inFolderOrAbove(
    filePath,
    async (dir) =>
      (await anyFileMatches(dir, ["ruff.toml", ".ruff.toml"])) ||
      (await anyFileMatches(
        dir,
        ["pyproject.toml"],
        /^\[tool\.(ruff|black)\b/m,
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
