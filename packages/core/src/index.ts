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
export { createAnthropicProvider, MissingApiKeyError } from "./ai/anthropic.js";
export type { AnthropicProviderOptions } from "./ai/anthropic.js";
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
export { buildCommentPrompt } from "./ai/prompts.js";

export { findAdapterForPath } from "./languages/adapter.js";
export type { LanguageAdapter } from "./languages/adapter.js";
export { defaultAdapters } from "./languages/index.js";
export { createPythonAdapter, pythonAdapter } from "./languages/python.js";
export type { PythonAdapterOptions } from "./languages/python.js";
export {
  javascriptAdapter,
  tsxAdapter,
  typescriptAdapter,
} from "./languages/typescript.js";
export type { ProcessResult, ProcessRunner } from "./process.js";

export { createUnifiedDiff } from "./diff.js";
export { compareTokenStreams, describeTokenMismatch } from "./verify.js";
export type { TokenComparison } from "./verify.js";
export { isSensitivePath, redactSecrets } from "./privacy.js";
