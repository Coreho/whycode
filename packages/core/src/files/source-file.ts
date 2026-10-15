// Reads and writes source files for front-ends. A file is only accepted if
// it is UTF-8 text, so that writing a result back can never mangle bytes that
// were lost in decoding, and it is only overwritten if nobody changed it in
// the meantime.
import { readFile, writeFile } from "node:fs/promises";

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

export type SourceWrite = { ok: true } | { ok: false; reason: string };

/**
 * Writes `code` over the file only if it still holds `expected` (the text it
 * was read with), so edits made while a person was reviewing are never lost.
 */
export async function writeSourceFile(
  absolutePath: string,
  code: string,
  expected: string,
): Promise<SourceWrite> {
  try {
    const current = await readSourceFile(absolutePath);
    if (!current.ok || current.code !== expected) {
      return {
        ok: false,
        reason: "the file changed on disk since it was read",
      };
    }
    await writeFile(absolutePath, code, "utf8");
    return { ok: true };
  } catch (error) {
    // Deleted, renamed, read-only or locked: report it, so one file can't
    // end a review session.
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: message };
  }
}
