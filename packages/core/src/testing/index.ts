// Test doubles for WhyCode, published as "@whycode/core/testing" so every
// front-end can run the real pipeline offline in its own tests.
export {
  claudeApiError,
  createFakeClaudeClient,
  textReply,
} from "./fake-claude-client.js";
export type { ClaudeReply, ClaudeRequestParams } from "./fake-claude-client.js";
export { commentPlanReply, FakeAIProvider } from "./fake-provider.js";
export type { FakeResponse } from "./fake-provider.js";
export {
  commentAboveEveryMatch,
  commentAboveFirstMatch,
  numberedLines,
} from "./scripted-replies.js";
export type { NumberedLine } from "./scripted-replies.js";
export { createToyAdapter, formatToyCode, toyTokens } from "./toy-adapter.js";
export type { ToyAdapterOptions } from "./toy-adapter.js";
