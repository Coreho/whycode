// Side-effect-free bundle entry for offline release verification with injected edges.
import { join } from "node:path";
import { useGrammarDirectory } from "@whycode/core";
export { runAction } from "./run.js";
export { githubClient } from "./main.js";
export { defaultAdapters, processFile, resolveConfig } from "@whycode/core";

/** Resolves shipped grammars relative to the copied bundle, never the workspace. */
export function initializeGrammars(): void {
  useGrammarDirectory(join(__dirname, "grammars"));
}
