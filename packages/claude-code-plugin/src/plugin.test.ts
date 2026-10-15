// Guards the plugin's shape and its safety promises: the manifest is valid,
// the skill is only run by the user, it pre-approves only commands that
// can't write, and it tells Claude every rule the CLI guarantees rely on.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/** The YAML frontmatter fields of a skill file (simple `key: value` lines). */
function frontmatter(markdown: string): Record<string, string> {
  const block = /^---\n([\s\S]*?)\n---\n/.exec(markdown.replace(/\r\n/g, "\n"));
  if (block?.[1] === undefined) throw new Error("no frontmatter");
  return Object.fromEntries(
    block[1].split("\n").map((line) => {
      const colon = line.indexOf(":");
      const value = line.slice(colon + 1).trim();
      return [line.slice(0, colon).trim(), value.replace(/^"(.*)"$/, "$1")];
    }),
  );
}

describe("the Claude Code plugin", () => {
  it("has a valid manifest named whycode", () => {
    const manifest = JSON.parse(read(".claude-plugin/plugin.json")) as {
      name?: string;
      version?: string;
    };
    expect(manifest.name).toBe("whycode");
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  describe("the cleanup skill", () => {
    const skill = read("skills/cleanup/SKILL.md");
    const fields = frontmatter(skill);

    it("is a user-invoked /cleanup command with paths and a comment level", () => {
      expect(fields.name).toBe("cleanup");
      expect(fields["disable-model-invocation"]).toBe("true");
      expect(fields["argument-hint"]).toMatch(/paths.*--comment-level/);
      expect(skill).toContain("$ARGUMENTS");
    });

    it("pre-approves only WhyCode commands that never write", () => {
      const tools = (fields["allowed-tools"] ?? "").split(/\s+(?=Bash\()/);
      expect(tools).toEqual([
        "Bash(whycode --version)",
        "Bash(whycode prompt:*)",
        "Bash(whycode preview:*)",
      ]);
    });

    it("keeps the rules the guarantees rely on", () => {
      expect(skill).toMatch(/Never change code yourself/);
      expect(skill).toMatch(/Only see code through `whycode prompt`/);
      expect(skill).toMatch(/only after the user approved that file's diff/);
      expect(skill).toMatch(
        /pass only the suggestion numbers the user accepted/,
      );
      expect(skill).toMatch(/Never pass `--yes`, `--refactor`/);
      expect(skill).toMatch(/AskUserQuestion/);
    });

    it("uses only the CLI commands and flags that exist", () => {
      const commands = [...skill.matchAll(/\bwhycode ([a-z]+)/g)].map(
        (match) => match[1],
      );
      expect(new Set(commands)).toEqual(
        new Set(["prompt", "preview", "write"]),
      );
      expect(skill).toContain("--plan - <<'WHYCODE_PLAN'");
      expect(skill).toContain("--fingerprint <fingerprint>");
    });
  });
});
