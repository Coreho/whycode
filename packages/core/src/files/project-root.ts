// Finds the project root a run works from: the git repository's top folder,
// else the nearest folder with a .whycoderc.json, else the starting folder.
// Config globs and .gitignore rules are all relative to this root.
import { access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { CONFIG_FILE_NAME } from "../config.js";

export async function findProjectRoot(startDir: string): Promise<string> {
  const start = resolve(startDir);
  return (
    (await findAncestorWith(start, ".git")) ??
    (await findAncestorWith(start, CONFIG_FILE_NAME)) ??
    start
  );
}

/** The nearest folder at or above `dir` that contains `name`. */
async function findAncestorWith(
  dir: string,
  name: string,
): Promise<string | undefined> {
  for (let current = dir; ; current = dirname(current)) {
    if (await exists(join(current, name))) return current;
    if (dirname(current) === current) return undefined;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
