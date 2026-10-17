// Opt-in review memory (`--review-state <file>`): remembers which files were
// reviewed with `whycode fix`, their still-pending comment suggestions, and
// the suggestions the person rejected, so an unchanged file isn't sent to the
// AI again and rejected suggestions don't come back. Only hashes and comment
// suggestions (with likely secrets masked) are stored, never source code.
// Config, prompt, tool changes and --refresh invalidate cached reviews.
// Rejections survive those changes, but only for the same source bytes.
import { lstat, readFile, writeFile } from "node:fs/promises";
import type {
  CollectedFile,
  ExistingCommentSuggestion,
  FileResult,
  LanguageAdapter,
  WhycodeConfig,
} from "@whycode/core";
import {
  captureCommentRequest,
  commentPlanSchema,
  processWithReply,
  readSourceFile,
  redactSecrets,
  resultFingerprint,
  writeSourceFile,
} from "@whycode/core";
import { configDigest, digest, toolIdentity } from "./saved-plan.js";
import type { FileOutcome } from "./run.js";

interface ReviewEntry {
  sourceHash: string;
  context: string;
  pending: ExistingCommentSuggestion[];
  rejected: string[];
  warnings: string[];
}

interface StateData {
  schema: 1;
  rootHash: string;
  tool: string;
  entries: Record<string, ReviewEntry>;
}

const emptyReply = JSON.stringify({
  insertions: [],
  existingCommentSuggestions: [],
});

const suggestionId = (suggestion: ExistingCommentSuggestion): string =>
  digest(
    JSON.stringify([
      suggestion.line,
      suggestion.original,
      suggestion.suggested,
    ]),
  );

/** The suggestion with likely secrets masked, so none reaches the state file. */
function withSecretsMasked(
  suggestion: ExistingCommentSuggestion,
): ExistingCommentSuggestion {
  const mask = (text: string) => redactSecrets(text).code;
  return {
    ...suggestion,
    original: mask(suggestion.original),
    suggested: mask(suggestion.suggested),
    reason: mask(suggestion.reason),
  };
}

/** The review-state file for one project, loaded once per run. */
export class ReviewState {
  private dirty = false;
  private constructor(
    private readonly path: string,
    private original: string | undefined,
    private readonly data: StateData,
    private readonly config: WhycodeConfig,
    private readonly adapters: readonly LanguageAdapter[],
  ) {}

  static async open(
    path: string,
    root: string,
    config: WhycodeConfig,
    adapters: readonly LanguageAdapter[],
  ): Promise<ReviewState> {
    let original: string | undefined;
    try {
      if ((await lstat(path)).isSymbolicLink())
        throw new Error("Review state must not be a symbolic link.");
      original = await readFile(path, "utf8");
    } catch (error) {
      if (!(
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ))
        throw error;
    }
    let data: StateData = {
      schema: 1,
      rootHash: digest(root),
      tool: await toolIdentity(),
      entries: {},
    };
    if (original !== undefined) {
      const parsed: unknown = JSON.parse(original);
      if (!validState(parsed))
        throw new Error(
          "Invalid review-state file; use a new path or remove the old file to reset it.",
        );
      if (parsed.rootHash === data.rootHash) {
        if (parsed.tool === data.tool) data = parsed;
        else {
          // New builds must regenerate reviews, but must not undo user decisions.
          data.entries = Object.fromEntries(
            Object.entries(parsed.entries).map(([path, entry]) => [
              path,
              { ...entry, context: "", pending: [], warnings: [] },
            ]),
          );
        }
      }
    }
    return new ReviewState(path, original, data, config, adapters);
  }

  private async context(
    file: CollectedFile,
    code: string,
  ): Promise<{ key: string; baseline: FileResult } | undefined> {
    const input = { path: file.path, absolutePath: file.absolutePath, code };
    const request = await captureCommentRequest(
      input,
      this.config,
      this.adapters,
    );
    if (!request.ok) return undefined;
    const baseline = await processWithReply(
      input,
      this.config,
      this.adapters,
      emptyReply,
    );
    if (baseline.status === "skipped" || baseline.verification !== "passed")
      return undefined;
    return {
      key: digest(
        JSON.stringify([
          configDigest(this.config),
          request.request,
          resultFingerprint(baseline),
        ]),
      ),
      baseline,
    };
  }

  async lookup(file: CollectedFile): Promise<FileOutcome | undefined> {
    const entry = Object.hasOwn(this.data.entries, file.path)
      ? this.data.entries[file.path]
      : undefined;
    if (!entry) return undefined;
    const source = await readSourceFile(file.absolutePath);
    if (!source.ok || digest(source.code) !== entry.sourceHash)
      return undefined;
    const context = await this.context(file, source.code);
    if (!context || context.key !== entry.context) return undefined;
    return {
      file,
      result: {
        ...context.baseline,
        status: "unchanged",
        originalCode: source.code,
        outputCode: source.code,
        diff: "",
        commentsAdded: 0,
        formatted: false,
        commentSuggestions: entry.pending,
        warnings: [
          ...entry.warnings,
          "Reused a matching saved review; no model request. Pending corrections still need explicit review.",
        ],
      },
    };
  }

  async remember(
    file: CollectedFile,
    result: FileResult,
    code: string,
    pending: ExistingCommentSuggestion[],
    rejected: ExistingCommentSuggestion[],
  ): Promise<void> {
    if (result.verification !== "passed" || result.mode !== "full") return;
    const rebased = reanchor(result.outputCode, code, pending);
    const rebasedRejected = reanchor(result.outputCode, code, rejected);
    // An ambiguous comment location must not disappear behind a remembered review.
    if (!rebased || !rebasedRejected) return;
    const source = await readSourceFile(file.absolutePath);
    if (!source.ok || source.code !== code) return;
    const context = await this.context(file, code);
    if (!context) return;
    const previous = Object.hasOwn(this.data.entries, file.path)
      ? this.data.entries[file.path]
      : undefined;
    this.data.entries[file.path] = {
      sourceHash: digest(code),
      context: context.key,
      pending: rebased.map(withSecretsMasked),
      rejected: [
        ...new Set([
          ...(previous?.sourceHash === digest(code) ? previous.rejected : []),
          ...rebasedRejected.map((suggestion) =>
            suggestionId(withSecretsMasked(suggestion)),
          ),
        ]),
      ],
      warnings: result.warnings.filter(
        (note) =>
          !note.startsWith("Reused a matching saved review") &&
          !note.startsWith("Withheld "),
      ),
    };
    this.dirty = true;
  }

  /** Filter only exact rejected rewrites anchored to the unchanged source. */
  filterRejected(outcome: FileOutcome): FileOutcome {
    if ("skip" in outcome) return outcome;
    const { file, result } = outcome;
    const entry = Object.hasOwn(this.data.entries, file.path)
      ? this.data.entries[file.path]
      : undefined;
    if (!entry || entry.sourceHash !== digest(result.originalCode))
      return outcome;
    const rejected = new Set(entry.rejected);
    const kept = result.commentSuggestions.filter((suggestion) => {
      // Suggestions refer to the proposed output, while saved decisions refer
      // to the file before this pass. Formatting/insertions can move that line.
      const anchored = reanchor(result.outputCode, result.originalCode, [
        suggestion,
      ])?.[0];
      if (!anchored) return true;
      return (
        !rejected.has(suggestionId(withSecretsMasked(anchored))) &&
        !rejected.has(suggestionId(anchored))
      ); // legacy unmasked hashes
    });
    const count = result.commentSuggestions.length - kept.length;
    if (count === 0) return outcome;
    return {
      file,
      result: {
        ...result,
        commentSuggestions: kept,
        warnings: [
          ...result.warnings,
          `Withheld ${count} previously rejected comment suggestion${count === 1 ? "" : "s"} for unchanged source.`,
        ],
      },
    };
  }

  async flush(): Promise<void> {
    if (!this.dirty) return;
    const text = JSON.stringify(this.data, null, 2) + "\n";
    if (this.original === undefined)
      await writeFile(this.path, text, { flag: "wx", mode: 0o600 });
    else {
      if ((await lstat(this.path)).isSymbolicLink())
        throw new Error(
          "Review state became a symbolic link; state was not saved.",
        );
      const written = await writeSourceFile(this.path, text, this.original);
      if (!written.ok)
        throw new Error(
          `Review state was not saved: ${written.reason}. Source write results are shown above.`,
        );
    }
    this.original = text;
    this.dirty = false;
  }
}

function validState(value: unknown): value is StateData {
  if (
    typeof value !== "object" ||
    value === null ||
    !("schema" in value) ||
    value.schema !== 1 ||
    !("rootHash" in value) ||
    typeof value.rootHash !== "string" ||
    !("tool" in value) ||
    typeof value.tool !== "string" ||
    !("entries" in value) ||
    typeof value.entries !== "object" ||
    value.entries === null ||
    Array.isArray(value.entries)
  )
    return false;
  return Object.values(value.entries).every((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) return false;
    const data = entry as Record<string, unknown>;
    if (
      typeof data.sourceHash !== "string" ||
      typeof data.context !== "string" ||
      !Array.isArray(data.rejected) ||
      !data.rejected.every((id) => typeof id === "string") ||
      !Array.isArray(data.warnings) ||
      !data.warnings.every((note) => typeof note === "string")
    )
      return false;
    return (
      commentPlanSchema.safeParse({
        insertions: [],
        existingCommentSuggestions: data.pending,
      }).success && Array.isArray(data.pending)
    );
  });
}

function reanchor(
  before: string,
  after: string,
  suggestions: ExistingCommentSuggestion[],
): ExistingCommentSuggestion[] | undefined {
  if (before === after || suggestions.length === 0) return suggestions;
  const oldLines = before.split(/\r?\n/);
  const newLines = after.split(/\r?\n/);
  const result: ExistingCommentSuggestion[] = [];
  for (const suggestion of suggestions) {
    const length = suggestion.original.trim().split(/\r?\n/).length;
    const block = oldLines
      .slice(suggestion.line - 1, suggestion.line - 1 + length)
      .map((line) => line.trim());
    const matches = newLines.flatMap((_, index) =>
      block.every((line, offset) => line === newLines[index + offset]?.trim())
        ? [index + 1]
        : [],
    );
    if (matches.length !== 1 || matches[0] === undefined) return undefined;
    result.push({ ...suggestion, line: matches[0] });
  }
  return result;
}
