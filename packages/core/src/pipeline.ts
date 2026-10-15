// Runs WhyCode on one file: format it, ask the AI where comments belong,
// insert them, and verify the code's logic is unchanged. Each numbered step
// matches "Core pipeline" in CLAUDE.md. Refactor mode instead asks the AI to
// rewrite the file and checks that the rewrite still parses. Nothing is
// written to disk here; front-ends decide what to do with the result.
import type {
  CommentInsertion,
  ExistingCommentSuggestion,
} from "./ai/comment-plan.js";
import { parseCommentPlan } from "./ai/comment-plan.js";
import { buildCommentPrompt, buildRefactorPrompt } from "./ai/prompts.js";
import type { AIProvider, AIRequest } from "./ai/provider.js";
import { parseRefactorPlan } from "./ai/refactor-plan.js";
import { applyInsertions } from "./comments/insert.js";
import type { WhycodeConfig } from "./config.js";
import { createUnifiedDiff } from "./diff.js";
import type { LanguageAdapter } from "./languages/adapter.js";
import { fileExtension, findAdapterForPath } from "./languages/adapter.js";
import type { CommentOnlyLanguage } from "./languages/fallback.js";
import { findCommentOnlyLanguage } from "./languages/fallback.js";
import { hasParseErrors } from "./languages/tree-sitter.js";
import { isSensitivePath, redactSecrets } from "./privacy.js";
import type { LineEnding } from "./text.js";
import {
  countLines,
  detectLineEnding,
  restoreLineEnding,
  toLf,
} from "./text.js";
import type { TestOutcome, TestRunner } from "./test-runner.js";
import { compareTokenStreams, describeTokenMismatch } from "./verify.js";

export interface FileInput {
  /** Path shown in diffs and used to pick the language; ideally repo-relative. */
  path: string;
  code: string;
  /** Where the file is on disk, so formatters find the project's settings. Defaults to path. */
  absolutePath?: string;
}

export interface PipelineDeps {
  provider: AIProvider;
  adapters: readonly LanguageAdapter[];
  /** Runs config.testCommand against a refactored file; refactor mode only. */
  runTests?: TestRunner;
}

export type FileStatus = "changed" | "unchanged" | "skipped";
/**
 * "comments-only": unsupported language, so no formatting and no verification.
 * "refactor": the AI rewrote the file, so its logic may have changed.
 */
export type ProcessingMode = "full" | "comments-only" | "refactor";
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
  /** AI comments inserted into outputCode (0 when they were discarded). */
  commentsAdded: number;
  /** True for refactor-mode rewrites: front-ends must warn that logic may have changed. */
  changesLogic: boolean;
  /** The AI's list of what it changed in refactor mode; empty otherwise. */
  refactorChanges: string[];
  /** Present when config.testCommand ran against the rewritten file. */
  testResult?: TestOutcome;
  warnings: string[];
}

const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

/** The AI gets one retry after an invalid reply, then the file is skipped. */
const MAX_AI_ATTEMPTS = 2;

type ResolvedLanguage =
  | { mode: "full"; adapter: LanguageAdapter }
  | { mode: "comments-only"; language: CommentOnlyLanguage };

/** Working state shared by both modes: LF code plus the original line ending. */
interface Job {
  input: FileInput;
  /** The code without a byte-order mark, with LF line endings. */
  code: string;
  lineEnding: LineEnding;
  /** A byte-order mark the file started with, put back on output. */
  byteOrderMark: string;
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
  // Step 1: detect the language.
  const language = resolveLanguage(input.path, deps.adapters);
  if (language === undefined) {
    return skippedResult(
      input,
      `unsupported file type "${fileExtension(input.path) || input.path}"`,
    );
  }

  // A byte-order mark is set aside so that nothing (such as a comment above
  // line 1) can end up in front of it, where it would break the code.
  const byteOrderMark = input.code.startsWith(BYTE_ORDER_MARK)
    ? BYTE_ORDER_MARK
    : "";
  const job: Job = {
    input,
    code: toLf(input.code.slice(byteOrderMark.length)),
    lineEnding: detectLineEnding(input.code),
    byteOrderMark,
    config,
    provider: deps.provider,
  };
  try {
    if (config.mode === "refactor") {
      return language.mode === "full"
        ? await runRefactorMode(job, language.adapter, deps.runTests)
        : skippedResult(
            input,
            `refactor mode needs full support for ${language.language.id}, so that the rewrite can be checked to parse`,
          );
    }
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
  const formatting = await formatCode(adapter, job.code, job.input);
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

  // Steps 5 and 6: insert the comments, re-format and verify. If that fails,
  // keep the comments that are safe on their own and try once more, so one
  // badly placed comment doesn't cost all the others.
  const verification = {
    adapter,
    input: job.input,
    formattedCode,
    tokensBefore,
  };
  let attempt = await insertAndVerify(verification, plan.insertions);
  if (!attempt.ok) {
    const salvage = await safeInsertions(verification, plan.insertions);
    const retry =
      salvage.kept.length > 0 && salvage.dropped.length > 0
        ? await insertAndVerify(verification, salvage.kept)
        : undefined;
    if (retry?.ok !== true) return keepFormattingOnly(attempt.reason);
    warnings.push(...salvage.dropped);
    attempt = retry;
  }
  warnings.push(...attempt.warnings);

  // Step 7: produce the result.
  return buildResult(job, {
    ...base,
    code: attempt.code,
    formatted: formatting.formatted,
    verification: "passed",
    suggestions: validSuggestions(
      plan.suggestions,
      formattedCode,
      attempt.mapLine,
      warnings,
    ),
    commentsAdded: attempt.inserted,
    warnings,
  });
}

/** What comment insertions are checked against. */
interface VerificationBase {
  adapter: LanguageAdapter;
  input: FileInput;
  formattedCode: string;
  tokensBefore: readonly string[];
}

type VerifiedInsertion =
  | {
      ok: true;
      code: string;
      mapLine: (line: number) => number;
      inserted: number;
      warnings: string[];
    }
  | { ok: false; reason: string };

/**
 * Inserts the comments, re-formats, and checks the token stream is
 * unchanged. A formatter that now rejects the code means the comments broke it.
 */
async function insertAndVerify(
  base: VerificationBase,
  insertions: readonly CommentInsertion[],
): Promise<VerifiedInsertion> {
  const warnings: string[] = [];
  const inserted = insertComments(
    base.formattedCode,
    insertions,
    base.adapter.lineComment,
    warnings,
  );
  let reformatted: string;
  try {
    reformatted = (await formatCode(base.adapter, inserted.code, base.input))
      .code;
  } catch (error) {
    return {
      ok: false,
      reason: `the formatter rejected the code after they were inserted (${errorMessage(error)})`,
    };
  }
  const comparison = compareTokenStreams(
    base.tokensBefore,
    await base.adapter.tokens(reformatted),
  );
  if (!comparison.equal) {
    return {
      ok: false,
      reason: `the code's tokens changed (${describeTokenMismatch(comparison)})`,
    };
  }
  return {
    ok: true,
    code: reformatted,
    mapLine: inserted.mapLine,
    inserted: inserted.inserted,
    warnings,
  };
}

/**
 * Checks each insertion on its own with tree-sitter only (no formatter run,
 * which can take seconds), keeping those that leave the tokens unchanged.
 */
async function safeInsertions(
  base: VerificationBase,
  insertions: readonly CommentInsertion[],
): Promise<{ kept: CommentInsertion[]; dropped: string[] }> {
  const kept: CommentInsertion[] = [];
  const dropped: string[] = [];
  for (const insertion of insertions) {
    const single = applyInsertions(
      base.formattedCode,
      [insertion],
      base.adapter.lineComment,
    );
    const comparison = compareTokenStreams(
      base.tokensBefore,
      await base.adapter.tokens(single.code),
    );
    if (comparison.equal) {
      kept.push(insertion);
    } else {
      dropped.push(
        `Dropped the comment for line ${insertion.line}: it would change the code's tokens (${describeTokenMismatch(comparison)}).`,
      );
    }
  }
  return { kept, dropped };
}

/** Runs the adapter's formatter and normalizes its output to LF line endings. */
async function formatCode(
  adapter: LanguageAdapter,
  code: string,
  input: FileInput,
): Promise<{ code: string; formatted: boolean }> {
  const result = await adapter.format(code, input.absolutePath ?? input.path);
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
    commentsAdded: inserted.inserted,
    warnings,
  });
}

/**
 * Refactor mode replaces steps 4–6: the AI rewrites the file, the rewrite
 * must still be valid code, and the project's tests run against it when a
 * test command is configured. Logic may change, so the result says so.
 */
async function runRefactorMode(
  job: Job,
  adapter: LanguageAdapter,
  runTests: TestRunner | undefined,
): Promise<FileResult> {
  const warnings: string[] = [];
  const base = { languageId: adapter.id, mode: "refactor" as const };
  const skip = (reason: string) => skippedResult(job.input, reason, base);

  // Step 2: format, so the AI and the diff start from clean code.
  const formatting = await formatCode(adapter, job.code, job.input);
  if (!formatting.formatted) {
    warnings.push(
      `No formatter available for ${adapter.id}; formatting was skipped.`,
    );
  }

  const plan = await requestRefactorPlan(job, adapter.id, formatting.code);
  if (!plan.ok) return skip(plan.error);

  // The rewrite must be valid code: the formatter accepts it and tree-sitter
  // parses it without errors.
  let rewritten: string;
  try {
    rewritten = (await formatCode(adapter, toLf(plan.code), job.input)).code;
  } catch (error) {
    return skip(
      `the formatter rejected the rewritten code (${errorMessage(error)})`,
    );
  }
  if (hasParseErrors(await adapter.tokens(rewritten))) {
    return skip("the rewritten code does not parse");
  }

  const result = buildResult(job, {
    ...base,
    code: rewritten,
    formatted: formatting.formatted,
    verification: "not-run",
    suggestions: [],
    refactorChanges: plan.changes,
    warnings,
  });
  if (result.status === "changed") {
    await addTestResult(result, job.config.testCommand, runTests);
  }
  return result;
}

/** Sends the code to the AI for a rewrite, unless it holds likely secrets. */
async function requestRefactorPlan(
  job: Job,
  languageId: string,
  code: string,
): Promise<{ ok: true; code: string; changes: string[] } | PlanFailure> {
  // Masked secrets come back as placeholders that can't be put back into
  // rewritten code reliably, so such files are never sent.
  if (redactSecrets(code).redactions > 0) {
    return {
      ok: false,
      error:
        "the file contains likely secrets, which refactor mode can't restore in rewritten code, so it was not sent to the AI",
    };
  }
  const request = buildRefactorPrompt({
    path: job.input.path,
    code,
    languageId,
    commentLevel: job.config.commentLevel,
  });
  const reply = await requestValidReply(
    job.provider,
    request,
    parseRefactorPlan,
  );
  if (!reply.ok) return reply;
  return { ok: true, code: reply.plan.code, changes: reply.plan.changes };
}

/** Runs the configured test command against the rewrite and records the outcome. */
async function addTestResult(
  result: FileResult,
  testCommand: string | null,
  runTests: TestRunner | undefined,
): Promise<void> {
  if (testCommand === null) return;
  if (runTests === undefined) {
    result.warnings.push(
      "A test command is configured, but this front-end can't run tests, so they were not run.",
    );
    return;
  }
  try {
    result.testResult = await runTests({
      path: result.path,
      code: result.outputCode,
      command: testCommand,
    });
  } catch (error) {
    result.warnings.push(`Tests could not be run: ${errorMessage(error)}`);
  }
}

type PlanFailure = { ok: false; error: string };

type PlanOutcome =
  | {
      ok: true;
      insertions: CommentInsertion[];
      suggestions: ExistingCommentSuggestion[];
      warnings: string[];
    }
  | PlanFailure;

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

  const reply = await requestValidReply(
    job.provider,
    request,
    parseCommentPlan,
  );
  if (!reply.ok) return reply;
  return {
    ok: true,
    insertions: reply.plan.insertions,
    suggestions: reply.plan.existingCommentSuggestions,
    warnings: redactionWarnings(redacted.redactions),
  };
}

/** Calls the AI until a reply parses, giving it one retry after an invalid reply. */
async function requestValidReply<Plan>(
  provider: AIProvider,
  request: AIRequest,
  parse: (
    raw: string,
  ) => { ok: true; plan: Plan } | { ok: false; error: string },
): Promise<{ ok: true; plan: Plan } | { ok: false; error: string }> {
  let lastError = "";
  for (let attempt = 1; attempt <= MAX_AI_ATTEMPTS; attempt++) {
    const reply = await callProvider(provider, request);
    if (!reply.ok) return reply;
    const parsed = parse(reply.text);
    if (parsed.ok) return parsed;
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
): { code: string; mapLine: (line: number) => number; inserted: number } {
  const result = applyInsertions(code, insertions, lineComment);
  warnings.push(...result.warnings);
  return {
    code: result.code,
    mapLine: (line) => result.lineMap[line - 1] ?? line,
    inserted: result.inserted,
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
  /** Refactor mode only: the AI's list of changes. */
  refactorChanges?: string[];
  /** AI comments in the final code; 0 when none were kept. */
  commentsAdded?: number;
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
      ? job.byteOrderMark + restoreLineEnding(fields.code, job.lineEnding)
      : job.input.code,
    // Diffed on LF text so CRLF files don't show "\r" in previews.
    diff: createUnifiedDiff(job.input.path, job.code, fields.code),
    commentSuggestions: fields.suggestions,
    commentsAdded: changed ? (fields.commentsAdded ?? 0) : 0,
    changesLogic: fields.mode === "refactor",
    refactorChanges: fields.refactorChanges ?? [],
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
    commentsAdded: 0,
    changesLogic: false,
    refactorChanges: [],
    warnings: [],
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
