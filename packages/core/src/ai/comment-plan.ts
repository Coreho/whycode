// Schema and parser for the AI's reply in the comment pass. The AI never
// returns rewritten code, only this "comment plan": where to insert new
// comments, and optional suggestions for improving existing ones.
import * as z from "zod";

const insertionSchema = z.object({
  /** 1-based line the comment goes above, in the code the AI was shown. */
  line: z.number().int().min(1),
  position: z.literal("above"),
  /** Comment text without comment markers; WhyCode adds the syntax. */
  text: z.string().trim().min(1),
});

const existingCommentSuggestionSchema = z.object({
  line: z.number().int().min(1),
  original: z.string(),
  suggested: z.string(),
  reason: z.string(),
});

export const commentPlanSchema = z.object({
  insertions: z.array(insertionSchema),
  // Optional because models often omit an empty list.
  existingCommentSuggestions: z
    .array(existingCommentSuggestionSchema)
    .default(() => []),
});

/**
 * The comment plan as a JSON Schema, for providers that can make the model's
 * reply match a schema. The "$schema" dialect marker is dropped because AI
 * APIs don't need it.
 */
export const commentPlanJsonSchema: Record<string, unknown> = (() => {
  const jsonSchema: Record<string, unknown> = {
    ...z.toJSONSchema(commentPlanSchema),
  };
  delete jsonSchema.$schema;
  return jsonSchema;
})();

export type CommentInsertion = z.output<typeof insertionSchema>;
export type ExistingCommentSuggestion = z.output<
  typeof existingCommentSuggestionSchema
>;
export type CommentPlan = z.output<typeof commentPlanSchema>;

export type CommentPlanParseResult =
  { ok: true; plan: CommentPlan } | { ok: false; error: string };

/** Parses and validates a raw AI reply. Never throws. */
export function parseCommentPlan(raw: string): CommentPlanParseResult {
  let json: unknown;
  try {
    json = JSON.parse(stripCodeFence(raw));
  } catch {
    return { ok: false, error: "AI response is not valid JSON." };
  }
  const result = commentPlanSchema.safeParse(json);
  if (!result.success) {
    return {
      ok: false,
      error: `AI response does not match the comment plan schema:\n${z.prettifyError(result.error)}`,
    };
  }
  return { ok: true, plan: result.data };
}

/** Models sometimes wrap JSON in a Markdown fence (```json ... ```) despite instructions. */
export function stripCodeFence(raw: string): string {
  const fenced = /^\s*```[\w-]*[ \t]*\r?\n([\s\S]*?)\r?\n?[ \t]*```\s*$/.exec(
    raw,
  );
  return fenced?.[1] ?? raw;
}
