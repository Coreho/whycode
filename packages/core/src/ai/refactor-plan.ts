// Schema and parser for the AI's reply in refactor mode: the whole rewritten
// file plus a list of what changed, which front-ends show next to the diff.
import * as z from "zod";
import { stripCodeFence } from "./comment-plan.js";

export const refactorPlanSchema = z.object({
  /** The complete rewritten file. */
  code: z.string().min(1),
  /** One short line per change, for the reviewer. */
  changes: z.array(z.string().trim().min(1)).default(() => []),
});

/** The refactor plan as a JSON Schema, without the "$schema" dialect marker. */
export const refactorPlanJsonSchema: Record<string, unknown> = (() => {
  const jsonSchema: Record<string, unknown> = {
    ...z.toJSONSchema(refactorPlanSchema),
  };
  delete jsonSchema.$schema;
  return jsonSchema;
})();

export type RefactorPlan = z.output<typeof refactorPlanSchema>;

export type RefactorPlanParseResult =
  { ok: true; plan: RefactorPlan } | { ok: false; error: string };

export function parseRefactorPlan(raw: string): RefactorPlanParseResult {
  let json: unknown;
  try {
    json = JSON.parse(stripCodeFence(raw));
  } catch {
    return { ok: false, error: "AI response is not valid JSON." };
  }
  const result = refactorPlanSchema.safeParse(json);
  if (!result.success) {
    return {
      ok: false,
      error: `AI response does not match the refactor plan schema:\n${z.prettifyError(result.error)}`,
    };
  }
  return { ok: true, plan: result.data };
}
