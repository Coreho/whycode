// Rust support: rustfmt formats stdin using the file's project settings,
// and tree-sitter supplies the comment-free tokens used for verification.
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ProcessRunner } from "../process.js";
import { runProcess } from "../process.js";
import type { LanguageAdapter } from "./adapter.js";
import type { GrammarSpec, TokenRules } from "./tree-sitter.js";
import { treeSitterTokens } from "./tree-sitter.js";

const RUST_GRAMMAR: GrammarSpec = {
  packageName: "tree-sitter-rust",
  wasmFile: "tree-sitter-rust.wasm",
};

const RUST_TOKEN_RULES: TokenRules = {
  commentTypes: new Set(["line_comment", "block_comment"]),
  // ///, //!, /** */ and /*! */ are attributes, not comments, to the
  // compiler, so text inserted inside one of them must be caught.
  docCommentMarkers: new Set([
    "outer_doc_comment_marker",
    "inner_doc_comment_marker",
  ]),
};

type ReadTextFile = (path: string) => Promise<string | undefined>;

export interface RustAdapterOptions {
  /** Replaces the subprocess runner; used by tests. */
  runProcess?: ProcessRunner;
  /** Reads project settings; undefined means the file doesn't exist. */
  readTextFile?: ReadTextFile;
}

export function createRustAdapter(
  options: RustAdapterOptions = {},
): LanguageAdapter {
  const run = options.runProcess ?? runProcess;
  const read = options.readTextFile ?? readOptionalTextFile;
  return {
    id: "rust",
    extensions: [".rs"],
    lineComment: "//",
    format: (code, filePath) => formatWithRustfmt(code, filePath, run, read),
    tokens: (code) => treeSitterTokens(code, RUST_GRAMMAR, RUST_TOKEN_RULES),
  };
}

export const rustAdapter = createRustAdapter();

/** Extracts a literal edition from [package], without treating metadata as package settings. */
export function cargoEdition(text: string): string | undefined {
  let inPackage = false;
  let multilineQuote: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (multilineQuote !== undefined) {
      if (line.includes(multilineQuote)) multilineQuote = undefined;
      continue;
    }
    const section = /^\s*\[([^\]]+)\]\]?\s*(?:#.*)?$/.exec(line);
    if (section !== null) {
      inPackage = /^(?:package|"package"|'package')$/.test(
        (section[1] ?? "").trim(),
      );
      continue;
    }
    const edition =
      /^\s*(?:edition|"edition"|'edition')\s*=\s*(["'])(2015|2018|2021|2024)\1\s*(?:#.*)?$/.exec(
        line,
      );
    if (inPackage && edition !== null) return edition[2];
    // Cargo descriptions may contain lines that look like TOML settings.
    const value = /^\s*[^#=]+?\s*=\s*("""|''')(.*)$/.exec(line);
    if (value !== null && !(value[2] ?? "").includes(value[1] ?? "")) {
      multilineQuote = value[1];
    }
  }
  return undefined;
}

/** Formats stdin, keeping rustfmt's code-only stdout and final newline intact. */
export async function formatWithRustfmt(
  code: string,
  filePath: string | undefined,
  run: ProcessRunner,
  read: ReadTextFile = readOptionalTextFile,
): Promise<{ code: string; formatted: boolean }> {
  const settings = await projectSettings(filePath, read);
  const configArgs =
    settings.configPath === undefined
      ? []
      : ["--config-path", settings.configPath];
  const result = await run(
    "rustfmt",
    ["--emit", "stdout", "--edition", settings.edition, ...configArgs],
    code,
  );
  if (result.kind === "not-found") return { code, formatted: false };
  if (result.exitCode !== 0) {
    const detail =
      result.stderr
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean) ?? "";
    throw new Error(`rustfmt failed (exit code ${result.exitCode}): ${detail}`);
  }
  return { code: result.stdout, formatted: true };
}

/** Edition stops at the nearest manifest; formatter config has its own upward search. */
async function projectSettings(
  filePath: string | undefined,
  read: ReadTextFile,
) {
  let edition = "2021";
  let manifestFound = false;
  let configPath: string | undefined;
  if (filePath === undefined) return { edition, configPath };
  let directory = dirname(resolve(filePath));
  for (;;) {
    if (!manifestFound) {
      const manifest = await read(join(directory, "Cargo.toml"));
      if (manifest !== undefined) {
        edition = cargoEdition(manifest) ?? "2021";
        manifestFound = true;
      }
    }
    if (configPath === undefined) {
      // Like rustfmt, prefer the dotted name when both exist at one level.
      for (const name of [".rustfmt.toml", "rustfmt.toml"]) {
        const candidate = join(directory, name);
        if ((await read(candidate)) !== undefined) {
          configPath = candidate;
          break;
        }
      }
    }
    const parent = dirname(directory);
    if (parent === directory || (manifestFound && configPath !== undefined))
      break;
    directory = parent;
  }
  return { edition, configPath };
}

async function readOptionalTextFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    )
      return undefined;
    throw error;
  }
}
