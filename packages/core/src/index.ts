// Public entry point of @whycode/core, the engine every WhyCode front-end
// (CLI, Claude Code plugin, VS Code extension, GitHub Action) builds on.

/** Version of the core engine, reported by front-ends in their output. */
export const version = "0.0.0";

export { processFile } from "./pipeline.js";
export type {
  FileInput,
  FileResult,
  FileStatus,
  PipelineDeps,
  ProcessingMode,
  VerificationStatus,
} from "./pipeline.js";

export {
  CONFIG_FILE_NAME,
  ConfigError,
  configSchema,
  loadConfig,
  resolveConfig,
} from "./config.js";
export type {
  CommentLevel,
  ConfigOverrides,
  Mode,
  ProviderName,
  WhycodeConfig,
} from "./config.js";

export type { AIProvider, AIRequest } from "./ai/provider.js";
export { createAnthropicProvider } from "./ai/anthropic.js";
export type { AnthropicProviderOptions } from "./ai/anthropic.js";
export { MissingApiKeyError } from "./ai/messages-api.js";
export {
  createOpenRouterProvider,
  OPENROUTER_BASE_URL,
  openRouterModelId,
} from "./ai/openrouter.js";
export type { OpenRouterProviderOptions } from "./ai/openrouter.js";
export { createConfiguredProvider } from "./ai/providers.js";
export {
  captureCommentRequest,
  processWithReply,
  resultFingerprint,
} from "./ai/external-model.js";
export type { CapturedRequest } from "./ai/external-model.js";
export type { ConfiguredProviderOptions } from "./ai/providers.js";
export {
  commentPlanJsonSchema,
  commentPlanSchema,
  parseCommentPlan,
} from "./ai/comment-plan.js";
export type {
  CommentInsertion,
  CommentPlan,
  CommentPlanParseResult,
  ExistingCommentSuggestion,
} from "./ai/comment-plan.js";
export { buildCommentPrompt, buildRefactorPrompt } from "./ai/prompts.js";
export {
  parseRefactorPlan,
  refactorPlanJsonSchema,
  refactorPlanSchema,
} from "./ai/refactor-plan.js";
export type {
  RefactorPlan,
  RefactorPlanParseResult,
} from "./ai/refactor-plan.js";
export { createFileSwapTestRunner } from "./test-runner.js";
export type {
  FileSwapTestRunnerOptions,
  TestOutcome,
  TestRunner,
  TestRunRequest,
} from "./test-runner.js";

export { findAdapterForPath } from "./languages/adapter.js";
export { useGrammarDirectory } from "./languages/tree-sitter.js";
export type { LanguageAdapter } from "./languages/adapter.js";
export { defaultAdapters } from "./languages/index.js";
export { createCSharpAdapter, csharpAdapter } from "./languages/csharp.js";
export type { CSharpAdapterOptions } from "./languages/csharp.js";
export { createGoAdapter, goAdapter } from "./languages/go.js";
export type { GoAdapterOptions } from "./languages/go.js";
export { createJavaAdapter, javaAdapter } from "./languages/java.js";
export type { JavaAdapterOptions } from "./languages/java.js";
export { createPythonAdapter, pythonAdapter } from "./languages/python.js";
export type { PythonAdapterOptions } from "./languages/python.js";
export { createRustAdapter, rustAdapter } from "./languages/rust.js";
export type { RustAdapterOptions } from "./languages/rust.js";
export {
  javascriptAdapter,
  tsxAdapter,
  typescriptAdapter,
} from "./languages/typescript.js";
export type { ProcessResult, ProcessRunner } from "./process.js";

export { collectFiles } from "./files/collect.js";
export type {
  CollectedFile,
  CollectOptions,
  FileCollection,
  SkipKind,
  SkippedPath,
} from "./files/collect.js";
export { findProjectRoot } from "./files/project-root.js";
export { readSourceFile, writeSourceFile } from "./files/source-file.js";
export type { SourceRead, SourceWrite } from "./files/source-file.js";
export { applyCommentSuggestions } from "./comments/suggestions.js";
export type { SuggestionsResult } from "./comments/suggestions.js";

export { createUnifiedDiff } from "./diff.js";
export {
  createLineSuggestions,
  containsLineRange,
  unifiedRightRanges,
} from "./line-suggestions.js";
export type {
  LineRange,
  LineSuggestion,
  LineSuggestions,
} from "./line-suggestions.js";
export { compareTokenStreams, describeTokenMismatch } from "./verify.js";
export type { TokenComparison } from "./verify.js";
export { isSensitivePath, redactSecrets } from "./privacy.js";
