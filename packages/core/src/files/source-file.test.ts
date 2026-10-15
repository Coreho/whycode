// Tests for reading source files: UTF-8 text is accepted byte-for-byte,
// binary and non-UTF-8 files are refused so they can't be mangled.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readSourceFile } from "./source-file.js";

describe("readSourceFile", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "whycode-source-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function readBytes(bytes: number[]) {
    const path = join(dir, "file.py");
    await writeFile(path, Buffer.from(bytes));
    return readSourceFile(path);
  }

  it("reads UTF-8 text, keeping a byte-order mark and CRLF line endings", async () => {
    const text = `${String.fromCharCode(0xfeff)}caf${String.fromCharCode(0xe9)} = 1\r\n`;
    expect(await readBytes([...Buffer.from(text, "utf8")])).toEqual({
      ok: true,
      code: text,
    });
  });

  it("refuses text in another encoding", async () => {
    // "café" in Latin-1: 0xE9 alone is not valid UTF-8.
    const result = await readBytes([0x63, 0x61, 0x66, 0xe9, 0x0a]);
    expect(result).toEqual({ ok: false, reason: "is not valid UTF-8 text" });
  });

  it("refuses binary files", async () => {
    const result = await readBytes([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]);
    expect(result).toEqual({ ok: false, reason: "looks like a binary file" });
  });
});
