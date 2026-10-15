// Guards the extension manifest (package.json): VS Code must load the
// bundle as CommonJS, vsce needs @types/vscode no newer than the engine,
// every contributed command must be registered, and nothing is installed at
// runtime because the build bundles everything.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import type * as vscode from "vscode";
import { activate } from "./extension.js";
import { fake } from "./testing/fake-vscode.js";

interface Manifest {
  type?: string;
  main?: string;
  engines?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  contributes: {
    commands: { command: string }[];
    menus: Record<string, { command: string }[]>;
    configuration: {
      properties: Record<string, { enum?: string[] }>;
    };
  };
}

const manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as Manifest;

beforeEach(() => fake.reset());

describe("the extension manifest", () => {
  it("points VS Code at the CommonJS bundle and installs nothing", () => {
    expect(manifest.type).toBeUndefined();
    expect(manifest.main).toBe("./dist/extension.js");
    expect(manifest.dependencies).toBeUndefined();
  });

  it("types the API of the oldest VS Code it supports", () => {
    const engine = manifest.engines?.vscode?.replace(/^\^/, "");
    const types = manifest.devDependencies?.["@types/vscode"]?.replace(
      /^~/,
      "",
    );
    expect(types).toBe(engine);
  });

  it("registers exactly the commands it contributes, and menus use only those", () => {
    activate({
      subscriptions: [],
      extensionPath: "",
    } as unknown as vscode.ExtensionContext);
    const contributed = manifest.contributes.commands.map((c) => c.command);
    expect([...fake.commands.keys()].sort()).toEqual([...contributed].sort());
    const inMenus = Object.values(manifest.contributes.menus)
      .flat()
      .map((item) => item.command);
    expect(contributed).toEqual(expect.arrayContaining(inMenus));
  });

  it("offers the settings the extension reads", () => {
    const { properties } = manifest.contributes.configuration;
    expect(properties["whycode.commentLevel"]?.enum).toEqual([
      "light",
      "medium",
      "heavy",
    ]);
    expect(properties["whycode.provider"]?.enum).toEqual([
      "auto",
      "vscode",
      "anthropic",
      "openrouter",
    ]);
  });
});
