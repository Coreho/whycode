// C# support: CSharpier formats stdin using the source file's project settings,
// and tree-sitter supplies the comment-free tokens used for verification.
import type { ProcessRunner } from "../process.js";
import { runProcess } from "../process.js";
import type { LanguageAdapter } from "./adapter.js";
import type { GrammarSpec, TokenRules } from "./tree-sitter.js";
import { treeSitterTokens } from "./tree-sitter.js";

const CSHARP_GRAMMAR: GrammarSpec = {
  packageName: "tree-sitter-c-sharp",
  wasmFile: "tree-sitter-c_sharp.wasm",
};

const CSHARP_TOKEN_RULES: TokenRules = {
  commentTypes: new Set(["comment"]),
};

export interface CSharpAdapterOptions {
  /** Replaces the subprocess runner; used by tests. */
  runProcess?: ProcessRunner;
}

export function createCSharpAdapter(
  options: CSharpAdapterOptions = {},
): LanguageAdapter {
  const run = options.runProcess ?? runProcess;
  return {
    id: "csharp",
    extensions: [".cs"],
    lineComment: "//",
    format: (code, filePath) => formatWithCSharpier(code, filePath, run),
    tokens: csharpTokens,
  };
}

export const csharpAdapter = createCSharpAdapter();

async function csharpTokens(code: string): Promise<string[]> {
  const tokens = await treeSitterTokens(
    code,
    CSHARP_GRAMMAR,
    CSHARP_TOKEN_RULES,
  );
  if (!code.includes("\u0085")) return tokens;
  // C# ends // comments at NEXT LINE, but this grammar does not. A second
  // stream exposes code hidden after it. Keep the original stream as well,
  // so NEXT LINE and LF inside string literals can never compare equal.
  const normalized = await treeSitterTokens(
    code.replaceAll("\u0085", "\n"),
    CSHARP_GRAMMAR,
    CSHARP_TOKEN_RULES,
  );
  return [...tokens, "<<csharp-next-line>>", ...normalized];
}

/** --stdin-path lets CSharpier discover .csharpierrc* and .editorconfig files. */
export async function formatWithCSharpier(
  code: string,
  filePath: string | undefined,
  run: ProcessRunner,
): Promise<{ code: string; formatted: boolean }> {
  const pathArgs = filePath === undefined ? [] : ["--stdin-path", filePath];
  const result = await run(
    "csharpier",
    ["format", "--write-stdout", ...pathArgs],
    code,
  );
  if (result.kind === "not-found") return { code, formatted: false };
  if (result.exitCode !== 0) {
    const detail =
      result.stderr
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean) ?? "";
    throw new Error(
      `csharpier failed (exit code ${result.exitCode}): ${detail}`,
    );
  }
  // An ignored --stdin-path exits successfully with no output. Never let a
  // formatter skip erase a nonempty file before verification even starts.
  if (result.stdout === "" && code.trim() !== "")
    return { code, formatted: false };
  return { code: result.stdout, formatted: true };
}
