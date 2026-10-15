// Comment syntax for common languages that have no full adapter yet.
// Files in these languages get comments only: no formatting and no
// logic-unchanged check, and results are labeled as such.
import { fileExtension } from "./adapter.js";

export interface CommentOnlyLanguage {
  id: string;
  lineComment: string;
}

const hash = (id: string): CommentOnlyLanguage => ({ id, lineComment: "#" });
const slashes = (id: string): CommentOnlyLanguage => ({
  id,
  lineComment: "//",
});
const dashes = (id: string): CommentOnlyLanguage => ({ id, lineComment: "--" });

const COMMENT_ONLY_LANGUAGES: Readonly<Record<string, CommentOnlyLanguage>> = {
  ".rb": hash("ruby"),
  ".sh": hash("shell"),
  ".bash": hash("shell"),
  ".pl": hash("perl"),
  ".r": hash("r"),
  ".c": slashes("c"),
  ".h": slashes("c"),
  ".cc": slashes("cpp"),
  ".cpp": slashes("cpp"),
  ".hpp": slashes("cpp"),
  ".php": slashes("php"),
  ".kt": slashes("kotlin"),
  ".kts": slashes("kotlin"),
  ".swift": slashes("swift"),
  ".scala": slashes("scala"),
  ".dart": slashes("dart"),
  ".sql": dashes("sql"),
  ".lua": dashes("lua"),
  ".hs": dashes("haskell"),
};

export function findCommentOnlyLanguage(
  path: string,
): CommentOnlyLanguage | undefined {
  return COMMENT_ONLY_LANGUAGES[fileExtension(path)];
}
