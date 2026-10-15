// Reads source files for front-ends. A file is only accepted if it is UTF-8
// text, so that writing a result back can never mangle bytes that were lost
// in decoding.
import { readFile } from "node:fs/promises";

export type SourceRead =
  { ok: true; code: string } | { ok: false; reason: string };

export async function readSourceFile(
  absolutePath: string,
): Promise<SourceRead> {
  const bytes = await readFile(absolutePath);
  if (bytes.includes(0)) {
    return { ok: false, reason: "looks like a binary file" };
  }
  const code = bytes.toString("utf8");
  // Invalid UTF-8 decodes to U+FFFD, so the text no longer round-trips.
  if (!Buffer.from(code, "utf8").equals(bytes)) {
    return { ok: false, reason: "is not valid UTF-8 text" };
  }
  return { ok: true, code };
}
