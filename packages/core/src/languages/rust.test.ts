// Tests Rust tokenization, project settings lookup, and fake and real rustfmt runs.
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProcessResult, ProcessRunner } from "../process.js";
import { toLf } from "../text.js";
import { findAdapterForPath } from "./adapter.js";
import { defaultAdapters } from "./index.js";
import {
  cargoEdition,
  createRustAdapter,
  formatWithRustfmt,
  rustAdapter,
} from "./rust.js";

const rustfmtInstalled = spawnSync("rustfmt", ["--version"]).status === 0;
const noFiles = () => Promise.resolve(undefined);

function fakeRunner(result: ProcessResult) {
  const calls: { command: string; args: readonly string[]; stdin: string }[] =
    [];
  const run: ProcessRunner = (command, args, stdin) => {
    calls.push({ command, args, stdin });
    return Promise.resolve(result);
  };
  return { run, calls };
}

describe("Rust adapter", () => {
  it("registers .rs files and ordinary line comments", () => {
    expect(findAdapterForPath("src/main.RS", defaultAdapters)).toBe(
      rustAdapter,
    );
    expect(rustAdapter.id).toBe("rust");
    expect(rustAdapter.extensions).toEqual([".rs"]);
    expect(rustAdapter.lineComment).toBe("//");
  });

  it("excludes line and nested block comments", async () => {
    const plain = "pub fn value() -> i32 { 2 }\n";
    const commented =
      "// ordinary\n/* outer /* nested */ end */\npub fn value( ) -> i32 { /* value */ 2 }\n";
    const tokens = await rustAdapter.tokens(plain);
    expect(tokens).toContain("value");
    expect(tokens.some((token) => token.startsWith("<<"))).toBe(false);
    expect(await rustAdapter.tokens(commented)).toEqual(tokens);
  });

  it("keeps all four forms of doc comments, each as one token", async () => {
    const docs = [
      "//! inner",
      "/*! inner block */",
      "/// outer",
      "/** outer block */",
    ];
    const tokens = await rustAdapter.tokens(
      `${docs.join("\n")}\npub fn value() -> i32 { 2 }\n`,
    );
    for (const doc of docs) {
      expect(tokens.some((token) => token.trim() === doc)).toBe(true);
    }
  });

  it("notices text added inside a block doc comment, but not a comment between doc lines", async () => {
    const tokensOf = (docs: string) =>
      rustAdapter.tokens(`${docs}\npub fn value() {}\n`);
    const block = await tokensOf("/**\nFirst.\nSecond.\n*/");
    expect(await tokensOf("/**\nFirst.\n// note\nSecond.\n*/")).not.toEqual(
      block,
    );
    const lines = await tokensOf("/// First.\n/// Second.");
    expect(await tokensOf("/// First.\n// note\n/// Second.")).toEqual(lines);
  });

  it.each([
    ["identifier", "pub fn other() -> i32 { 2 * 3 }"],
    ["operator", "pub fn value() -> i32 { 2 + 3 }"],
    ["literal", "pub fn value() -> i32 { 2 * 4 }"],
  ])("detects a changed %s", async (_change, code) => {
    expect(await rustAdapter.tokens(code)).not.toEqual(
      await rustAdapter.tokens("pub fn value() -> i32 { 2 * 3 }"),
    );
  });
});

describe("cargoEdition", () => {
  it.each([
    ['[package]\nedition = "2024" # current\n', "2024"],
    ["[ package ]\r\n edition = '2018'\r\n", "2018"],
    ["['package']\n'edition' = '2015'\n", "2015"],
    ["[package] # comment with ]\nedition = '2021'", "2021"],
    ['[workspace.package]\nedition = "2024"\n', undefined],
    ['[package.metadata]\nedition = "2024"\n', undefined],
    ["[package]\nname = \"app\"\n[dependencies]\nedition = '2018'", undefined],
    ["[package]\n# edition = '2018'\n", undefined],
    ["[package]\nname = 'app'\n[[bin]]\nedition = '2018'", undefined],
    ["[package]\nedition.workspace = true\n", undefined],
    ["[package]\nedition = '2099'\n", undefined],
    [
      "[package]\ndescription = '''\nedition = '2015'\n'''\nedition = '2021'",
      "2021",
    ],
    [
      '[package]\ndescription = """\n[package]\nedition = \'2015\'\n"""\nedition = "2024"',
      "2024",
    ],
    ["", undefined],
  ])(
    "extracts only a supported literal package edition: %j",
    (text, edition) => {
      expect(cargoEdition(text)).toBe(edition);
    },
  );
});

describe("formatWithRustfmt", () => {
  it("passes code on stdin, selects the nearest manifest and config, and preserves stdout", async () => {
    const { run, calls } = fakeRunner({
      kind: "completed",
      exitCode: 0,
      stdout: "fn main() {}\n",
      stderr: "",
    });
    const root = resolve("virtual-rust-project");
    const files = new Map([
      [join(root, "Cargo.toml"), "[package]\nedition = '2018'"],
      [join(root, "nested", "Cargo.toml"), "[package]\nedition = '2024'"],
      [join(root, "rustfmt.toml"), "hard_tabs = true"],
      [join(root, ".rustfmt.toml"), "tab_spaces = 2"],
    ]);
    const read = (path: string) => Promise.resolve(files.get(path));
    expect(
      await formatWithRustfmt(
        "fn main(){}",
        join(root, "nested", "src", "main.rs"),
        run,
        read,
      ),
    ).toEqual({ code: "fn main() {}\n", formatted: true });
    expect(calls).toEqual([
      {
        command: "rustfmt",
        args: [
          "--emit",
          "stdout",
          "--edition",
          "2024",
          "--config-path",
          join(root, ".rustfmt.toml"),
        ],
        stdin: "fn main(){}",
      },
    ]);
  });

  it("prefers a nearer rustfmt.toml over a more distant .rustfmt.toml", async () => {
    const { run, calls } = fakeRunner({ kind: "not-found" });
    const root = resolve("virtual-rust-project");
    const files = new Map([
      [join(root, ".rustfmt.toml"), "hard_tabs = true"],
      [join(root, "src", "rustfmt.toml"), "tab_spaces = 2"],
    ]);
    await formatWithRustfmt("", join(root, "src", "lib.rs"), run, (path) =>
      Promise.resolve(files.get(path)),
    );
    expect(calls[0]?.args).toContain(join(root, "src", "rustfmt.toml"));
  });

  it.each([undefined, "src/lib.rs"])(
    "defaults to edition 2021 without project settings (%s)",
    async (path) => {
      const { run, calls } = fakeRunner({ kind: "not-found" });
      expect(
        await formatWithRustfmt("async fn f(){}", path, run, noFiles),
      ).toEqual({ code: "async fn f(){}", formatted: false });
      expect(calls[0]?.args).toEqual(["--emit", "stdout", "--edition", "2021"]);
    },
  );

  it("stops at the nearest manifest even when it has no edition", async () => {
    const { run, calls } = fakeRunner({ kind: "not-found" });
    const root = resolve("virtual-rust-project");
    const files = new Map([
      [join(root, "Cargo.toml"), "[package]\nedition = '2015'"],
      [join(root, "src", "Cargo.toml"), "[package]\nname = 'nested'"],
    ]);
    await formatWithRustfmt("", join(root, "src", "lib.rs"), run, (path) =>
      Promise.resolve(files.get(path)),
    );
    expect(calls[0]?.args).toEqual(["--emit", "stdout", "--edition", "2021"]);
  });

  it("throws the first meaningful stderr line on failure", async () => {
    const { run } = fakeRunner({
      kind: "completed",
      exitCode: 1,
      stdout: "",
      stderr: "\r\n  error: unclosed delimiter\r\nmore detail",
    });
    await expect(
      formatWithRustfmt("fn f(){", undefined, run, noFiles),
    ).rejects.toThrow(
      "rustfmt failed (exit code 1): error: unclosed delimiter",
    );
  });

  it("uses the injected runner and filesystem through adapter.format", async () => {
    const { run, calls } = fakeRunner({ kind: "not-found" });
    const adapter = createRustAdapter({
      runProcess: run,
      readTextFile: noFiles,
    });
    await adapter.format("fn f(){}", "src/lib.rs");
    expect(calls).toHaveLength(1);
  });

  it("reports filesystem errors rather than hiding unreadable settings", async () => {
    const { run, calls } = fakeRunner({ kind: "not-found" });
    const adapter = createRustAdapter({
      runProcess: run,
      readTextFile: () => Promise.reject(new Error("permission denied")),
    });
    await expect(adapter.format("", "lib.rs")).rejects.toThrow(
      "permission denied",
    );
    expect(calls).toHaveLength(0);
  });

  it.skipIf(!rustfmtInstalled)(
    "formats async/dyn syntax with real rustfmt and no stdin header",
    async () => {
      const code =
        "pub async fn preview(value:&dyn std::fmt::Display)->String{value.to_string()}";
      const result = await rustAdapter.format(code);
      expect({ ...result, code: toLf(result.code) }).toEqual({
        code: "pub async fn preview(value: &dyn std::fmt::Display) -> String {\n    value.to_string()\n}\n",
        formatted: true,
      });
      await expect(rustAdapter.format("fn broken( {")).rejects.toThrow(
        /rustfmt failed .*error:/,
      );
    },
  );

  it.skipIf(!rustfmtInstalled).each(["rustfmt.toml", ".rustfmt.toml"])(
    "applies a real ancestor %s and Cargo edition from stdin",
    async (name) => {
      const directory = await mkdtemp(join(tmpdir(), "whycode-rustfmt-"));
      try {
        const source = join(directory, "src", "nested");
        await mkdir(source, { recursive: true });
        await writeFile(
          join(directory, "Cargo.toml"),
          "[package]\nedition = '2024'\n",
        );
        await writeFile(
          join(directory, name),
          "hard_tabs = true\nedition = '2015'\n",
        );
        const result = await rustAdapter.format(
          "async fn f(){let value=1;}",
          join(source, "lib.rs"),
        );
        expect({ ...result, code: toLf(result.code) }).toEqual({
          code: "async fn f() {\n\tlet value = 1;\n}\n",
          formatted: true,
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
