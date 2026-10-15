// Builds the request for the AI comment pass. This is a minimal version so
// the pipeline runs end to end; Phase 5 replaces it with tuned prompts.
import type { CommentLevel } from "../config.js";
import type { AIRequest } from "./provider.js";

export interface CommentPromptInput {
  code: string;
  languageId: string;
  commentLevel: CommentLevel;
}

const LEVEL_GUIDANCE: Readonly<Record<CommentLevel, string>> = {
  light:
    "Add a one-line summary above each function and class. Elsewhere, comment only non-obvious decisions: explain why, not what.",
  medium:
    "Do everything the light level does, plus a short note above each logical block inside functions.",
  heavy:
    "Explain the code nearly line by line, for a reader who is learning the language.",
};

const SYSTEM_PROMPT = [
  "You add explanatory comments to source code so humans can understand it.",
  "Never rewrite, reorder, or remove code. Never edit existing comments.",
  "Reply with JSON only, matching this shape:",
  '{"insertions":[{"line":<number>,"position":"above","text":"<comment text>"}],',
  ' "existingCommentSuggestions":[{"line":<number>,"original":"...","suggested":"...","reason":"..."}]}',
  "Line numbers refer to the numbered code you are given. Each insertion is placed above that line.",
  "Write comment text without comment markers; they are added for you.",
  "Use existingCommentSuggestions only for existing comments that are wrong or unclear.",
].join("\n");

export function buildCommentPrompt(input: CommentPromptInput): AIRequest {
  const user = [
    `Language: ${input.languageId}`,
    `Comment level: ${input.commentLevel}. ${LEVEL_GUIDANCE[input.commentLevel]}`,
    "",
    "Code:",
    numberLines(input.code),
  ].join("\n");
  return { system: SYSTEM_PROMPT, user };
}

/** Prefixes each line with its 1-based number, e.g. "12| return x". */
export function numberLines(code: string): string {
  return code
    .split("\n")
    .map((line, index) => `${index + 1}| ${line}`)
    .join("\n");
}
