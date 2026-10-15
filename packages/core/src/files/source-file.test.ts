// Tests for reading and writing source files: UTF-8 text is accepted
// byte-for-byte, other files are refused, and edits made meanwhile are kept.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readSourceFile, writeSourceFile } from "./source-file.js";

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

describe("writeSourceFile", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "whycode-write-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes when the file still holds what was read", async () => {
    const path = join(dir, "a.py");
    await writeFile(path, "x=1\r\n");
    expect(await writeSourceFile(path, "x = 1\r\n", "x=1\r\n")).toEqual({
      ok: true,
    });
    expect(await readFile(path, "utf8")).toBe("x = 1\r\n");
  });

  it("refuses to overwrite a file that changed since it was read", async () => {
    const path = join(dir, "a.py");
    await writeFile(path, "edited meanwhile\n");
    const result = await writeSourceFile(path, "x = 1\n", "x=1\n");
    expect(result).toEqual({
      ok: false,
      reason: "the file changed on disk since it was read",
    });
    expect(await readFile(path, "utf8")).toBe("edited meanwhile\n");
  });
});

describe("writeSourceFile failures", () => {
  it("reports a file that was deleted during the review instead of throwing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "whycode-gone-"));
    try {
      const result = await writeSourceFile(join(dir, "gone.py"), "x\n", "x\n");
      expect(result.ok).toBe(false);
      expect(!result.ok && result.reason).toMatch(/ENOENT/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
