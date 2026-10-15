// Tests for reading WhyCode's VS Code settings.
import { beforeEach, describe, expect, it } from "vitest";
import { readSettings } from "./settings.js";
import { fake } from "./testing/fake-vscode.js";

beforeEach(() => fake.reset());

describe("readSettings", () => {
  it("leaves the comment level to .whycoderc.json until it is set", () => {
    expect(readSettings(undefined)).toEqual({
      commentLevel: undefined,
      provider: "auto",
    });
  });

  it("returns the values the user set", () => {
    fake.settings["whycode.commentLevel"] = "heavy";
    fake.settings["whycode.provider"] = "vscode";
    expect(readSettings(undefined)).toEqual({
      commentLevel: "heavy",
      provider: "vscode",
    });
  });

  it("ignores values that aren't valid choices", () => {
    fake.settings["whycode.commentLevel"] = "loud";
    fake.settings["whycode.provider"] = "openai";
    expect(readSettings(undefined)).toEqual({
      commentLevel: undefined,
      provider: "auto",
    });
  });
});
