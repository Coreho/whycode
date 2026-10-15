// Runs WhyCode on one file: format it, ask the AI where comments belong,
// insert them, and verify the code's logic is unchanged. Each numbered step
// matches "Core pipeline" in CLAUDE.md. Nothing is written to disk here;
// front-ends decide what to do with the result.
import type {
  CommentInsertion,
  ExistingCommentSuggestion,
} from "./ai/comment-plan.js";
import { parseCommentPlan } from "./ai/comment-plan.js";
import { buildCommentPrompt } from "./ai/prompts.js";
import type { AIProvider, AIRequest } from "./ai/provider.js";
import { applyInsertions } from "./comments/insert.js";
import type { WhycodeConfig } from "./config.js";
import { createUnifiedDiff } from "./diff.js";
import type { LanguageAdapter } from "./languages/adapter.js";
import { fileExtension, findAdapterForPath } from "./languages/adapter.js";
import type { CommentOnlyLanguage } from "./languages/fallback.js";
import { findCommentOnlyLanguage } from "./languages/fallback.js";
import { isSensitivePath, redactSecrets } from "./privacy.js";
import type { LineEnding } from "./text.js";
import {
  countLines,
  detectLineEnding,
  restoreLineEnding,
  toLf,
} from "./text.js";
import { compareTokenStreams, describeTokenMismatch } from "./verify.js";

export interface FileInput {
  /** Path shown in diffs and used to pick the language; ideally repo-relative. */
  path: string;
  code: string;
}

export interface PipelineDeps {
  provider: AIProvider;
  adapters: readonly LanguageAdapter[];
}

export type FileStatus = "changed" | "unchanged" | "skipped";
/** "comments-only": unsupported language, so no formatting and no verification. */
export type ProcessingMode = "full" | "comments-only";
export type VerificationStatus = "passed" | "failed" | "not-run";

export interface FileResult {
  path: string;
  status: FileStatus;
  skipReason?: string;
  languageId: string | null;
  mode: ProcessingMode | null;
  formatted: boolean;
  verification: VerificationStatus;
  originalCode: string;
  outputCode: string;
  diff: string;
  /** Suggested rewrites of existing comments; line numbers refer to outputCode. */
  commentSuggestions: ExistingCommentSuggestion[];
  warnings: string[];
}

/** The AI gets one retry after an invalid reply, then the file is skipped. */
const MAX_AI_ATTEMPTS = 2;

type ResolvedLanguage =
  | { mode: "full"; adapter: LanguageAdapter }
  | { mode: "comments-only"; language: CommentOnlyLanguage };

/** Working state shared by both modes: LF code plus the original line ending. */
interface Job {
  input: FileInput;
  code: string;
  lineEnding: LineEnding;
  config: WhycodeConfig;
  provider: AIProvider;
}

export async function processFile(
  input: FileInput,
  config: WhycodeConfig,
  deps: PipelineDeps,
): Promise<FileResult> {
  if (isSensitivePath(input.path)) {
    return skippedResult(
      input,
      "file may hold secrets (env, key, or credentials file), so it is never sent to an AI",
    );
  }
  if (config.mode === "refactor") {
    return skippedResult(input, "refactor mode is not implemented yet");
  }
  // Step 1: detect the language.
  const language = resolveLanguage(input.path, deps.adapters);
  if (language === undefined) {
    return skippedResult(
      input,
      `unsupported file type "${fileExtension(input.path) || input.path}"`,
    );
  }

  const job: Job = {
    input,
    code: toLf(input.code),
    lineEnding: detectLineEnding(input.code),
    config,
    provider: deps.provider,
  };
  try {
    return language.mode === "full"
      ? await runFullMode(job, language.adapter)
      : await runCommentsOnlyMode(job, language.language);
  } catch (error) {
    // One broken file (e.g. a syntax error the formatter rejects) must not stop a batch.
    return skippedResult(input, `processing failed: ${errorMessage(error)}`);
  }
}

function resolveLanguage(
  path: string,
  adapters: readonly LanguageAdapter[],
): ResolvedLanguage | undefined {
  const adapter = findAdapterForPath(path, adapters);
  if (adapter !== undefined) return { mode: "full", adapter };
  const language = findCommentOnlyLanguage(path);
  if (language !== undefined) return { mode: "comments-only", language };
  return undefined;
}

async function runFullMode(
  job: Job,
  adapter: LanguageAdapter,
): Promise<FileResult> {
  const warnings: string[] = [];
  const base = { languageId: adapter.id, mode: "full" as const };

  // Step 2: format. A missing formatter is a warning, not a failure.
  const formatting = await formatCode(adapter, job.code, job.input.path);
  if (!formatting.formatted) {
    warnings.push(
      `No formatter available for ${adapter.id}; formatting was skipped.`,
    );
  }
  const formattedCode = formatting.code;

  // Step 3: record the comment-free token stream.
  const tokensBefore = await adapter.tokens(formattedCode);

  // Step 4: AI comment pass.
  const plan = await requestCommentPlan(job, adapter.id, formattedCode);
  if (!plan.ok) return skippedResult(job.input, plan.error, base);
  warnings.push(...plan.warnings);

  /** Throws away the inserted comments but keeps the formatting and suggestions. */
  const keepFormattingOnly = (reason: string): FileResult => {
    warnings.push(
      `AI comments were discarded because ${reason}. Only formatting was kept.`,
    );
    return buildResult(job, {
      ...base,
      code: formattedCode,
      formatted: formatting.formatted,
      verification: "failed",
      suggestions: validSuggestions(
        plan.suggestions,
        formattedCode,
        identityLineMap,
        warnings,
      ),
      warnings,
    });
  };

  // Step 5: insert comments, then re-format. A formatter that now rejects
  // the code means the comments broke it.
  const inserted = insertComments(
    formattedCode,
    plan.insertions,
    adapter.lineComment,
    warnings,
  );
  let reformatted: string;
  try {
    reformatted = (await formatCode(adapter, inserted.code, job.input.path))
      .code;
  } catch (error) {
    return keepFormattingOnly(
      `the formatter rejected the code after they were inserted (${errorMessage(error)})`,
    );
  }

  // Step 6: verify the token stream is unchanged.
  const comparison = compareTokenStreams(
    tokensBefore,
    await adapter.tokens(reformatted),
  );
  if (!comparison.equal) {
    return keepFormattingOnly(
      `the code's tokens changed (${describeTokenMismatch(comparison)})`,
    );
  }

  // Step 7: produce the result.
  return buildResult(job, {
    ...base,
    code: reformatted,
    formatted: formatting.formatted,
    verification: "passed",
    suggestions: validSuggestions(
      plan.suggestions,
      formattedCode,
      inserted.mapLine,
      warnings,
    ),
    warnings,
  });
}

/** Runs the adapter's formatter and normalizes its output to LF line endings. */
async function formatCode(
  adapter: LanguageAdapter,
  code: string,
  filePath: string,
): Promise<{ code: string; formatted: boolean }> {
  const result = await adapter.format(code, filePath);
  return { code: toLf(result.code), formatted: result.formatted };
}

async function runCommentsOnlyMode(
  job: Job,
  language: CommentOnlyLanguage,
): Promise<FileResult> {
  const base = { languageId: language.id, mode: "comments-only" as const };
  const warnings = [
    `${language.id} has no full support yet: comments were added without formatting or the logic-unchanged check.`,
  ];

  const plan = await requestCommentPlan(job, language.id, job.code);
  if (!plan.ok) return skippedResult(job.input, plan.error, base);
  warnings.push(...plan.warnings);

  const inserted = insertComments(
    job.code,
    plan.insertions,
    language.lineComment,
    warnings,
  );
  return buildResult(job, {
    ...base,
    code: inserted.code,
    formatted: false,
    verification: "not-run",
    suggestions: validSuggestions(
      plan.suggestions,
      job.code,
      inserted.mapLine,
      warnings,
    ),
    warnings,
  });
}

type PlanOutcome =
  | {
      ok: true;
      insertions: CommentInsertion[];
      suggestions: ExistingCommentSuggestion[];
      warnings: string[];
    }
  | { ok: false; error: string };

/** Sends redacted code to the AI and returns a validated comment plan. */
async function requestCommentPlan(
  job: Job,
  languageId: string,
  code: string,
): Promise<PlanOutcome> {
  const redacted = redactSecrets(code);
  const request = buildCommentPrompt({
    path: job.input.path,
    code: redacted.code,
    languageId,
    commentLevel: job.config.commentLevel,
  });

  let lastError = "";
  for (let attempt = 1; attempt <= MAX_AI_ATTEMPTS; attempt++) {
    const reply = await callProvider(job.provider, request);
    if (!reply.ok) return reply;
    const parsed = parseCommentPlan(reply.text);
    if (parsed.ok) {
      return {
        ok: true,
        insertions: parsed.plan.insertions,
        suggestions: parsed.plan.existingCommentSuggestions,
        warnings: redactionWarnings(redacted.redactions),
      };
    }
    lastError = parsed.error;
  }
  return {
    ok: false,
    error: `AI returned an invalid reply ${MAX_AI_ATTEMPTS} times. ${lastError}`,
  };
}

async function callProvider(
  provider: AIProvider,
  request: AIRequest,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  try {
    return { ok: true, text: await provider.complete(request) };
  } catch (error) {
    return {
      ok: false,
      error: `AI provider "${provider.name}" failed: ${errorMessage(error)}`,
    };
  }
}

function redactionWarnings(redactions: number): string[] {
  if (redactions === 0) return [];
  return [
    `${redactions} likely secret(s) were masked before the code was sent to the AI.`,
  ];
}

function insertComments(
  code: string,
  insertions: readonly CommentInsertion[],
  lineComment: string,
  warnings: string[],
): { code: string; mapLine: (line: number) => number } {
  const result = applyInsertions(code, insertions, lineComment);
  warnings.push(...result.warnings);
  return {
    code: result.code,
    mapLine: (line) => result.lineMap[line - 1] ?? line,
  };
}

const identityLineMap = (line: number): number => line;

/** Drops suggestions pointing past the end of the file and renumbers the rest. */
function validSuggestions(
  suggestions: readonly ExistingCommentSuggestion[],
  code: string,
  mapLine: (line: number) => number,
  warnings: string[],
): ExistingCommentSuggestion[] {
  const lineCount = countLines(code);
  return suggestions.flatMap((suggestion) => {
    if (suggestion.line > lineCount) {
      warnings.push(
        `Dropped a comment suggestion for line ${suggestion.line}: the file is shorter.`,
      );
      return [];
    }
    return [{ ...suggestion, line: mapLine(suggestion.line) }];
  });
}

interface ResultFields {
  languageId: string;
  mode: ProcessingMode;
  /** Final code, LF line endings. */
  code: string;
  formatted: boolean;
  verification: VerificationStatus;
  suggestions: ExistingCommentSuggestion[];
  warnings: string[];
}

function buildResult(job: Job, fields: ResultFields): FileResult {
  const changed = fields.code !== job.code;
  return {
    path: job.input.path,
    status: changed ? "changed" : "unchanged",
    languageId: fields.languageId,
    mode: fields.mode,
    formatted: fields.formatted,
    verification: fields.verification,
    originalCode: job.input.code,
    outputCode: changed
      ? restoreLineEnding(fields.code, job.lineEnding)
      : job.input.code,
    // Diffed on LF text so CRLF files don't show "\r" in previews.
    diff: createUnifiedDiff(job.input.path, job.code, fields.code),
    commentSuggestions: fields.suggestions,
    warnings: fields.warnings,
  };
}

function skippedResult(
  input: FileInput,
  reason: string,
  language?: { languageId: string; mode: ProcessingMode },
): FileResult {
  return {
    path: input.path,
    status: "skipped",
    skipReason: reason,
    languageId: language?.languageId ?? null,
    mode: language?.mode ?? null,
    formatted: false,
    verification: "not-run",
    originalCode: input.code,
    outputCode: input.code,
    diff: "",
    commentSuggestions: [],
    warnings: [],
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
