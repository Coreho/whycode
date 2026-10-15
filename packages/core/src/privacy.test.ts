// Tests for the privacy guards: secret-bearing files are refused, and secrets
// in code are masked without moving any lines.
import { describe, expect, it } from "vitest";
import { isSensitivePath, redactSecrets } from "./privacy.js";

// Fake secrets are assembled at runtime so this file never contains a
// string that looks like a real key to secret scanners.
const fakeAnthropicKey = "sk-ant-" + "a1B2c3D4".repeat(4);
const fakeAwsKeyId = "AKIA" + "ABCDEFGHIJKLMNOP";
const fakeGithubToken = "ghp_" + "x".repeat(36);
const fakeSlackToken = "xoxb-" + "1234567890-abc";

describe("isSensitivePath", () => {
  it.each([
    ".env",
    ".env.local",
    "config/.env.production",
    "certs/server.pem",
    "deploy.key",
    "C:\\Users\\me\\.ssh\\id_rsa",
    "home/.npmrc",
    "store.p12",
  ])("refuses %s", (path) => {
    expect(isSensitivePath(path)).toBe(true);
  });

  it.each([
    "src/app.ts",
    "environment.ts",
    "keyboard.py",
    "docs/env.md",
    "monkey.js",
  ])("allows %s", (path) => {
    expect(isSensitivePath(path)).toBe(false);
  });
});

describe("redactSecrets", () => {
  it("masks well-known token formats", () => {
    const code = [
      `const anthropic = "${fakeAnthropicKey}";`,
      `aws_id = '${fakeAwsKeyId}'`,
      `GITHUB=${fakeGithubToken}`,
      `slack: ${fakeSlackToken}`,
    ].join("\n");
    const result = redactSecrets(code);
    for (const secret of [
      fakeAnthropicKey,
      fakeAwsKeyId,
      fakeGithubToken,
      fakeSlackToken,
    ]) {
      expect(result.code).not.toContain(secret);
    }
    expect(result.redactions).toBe(4);
  });

  it("masks quoted values assigned to secret-sounding names", () => {
    const result = redactSecrets(
      `password = "hunter2hunter2"\nconfig = { apiKey: 'abcd1234efgh' }`,
    );
    expect(result.code).toBe(
      `password = "[REDACTED]"\nconfig = { apiKey: '[REDACTED]' }`,
    );
    expect(result.redactions).toBe(2);
  });

  it("masks private key bodies but keeps the line count", () => {
    const code = [
      "key = '''",
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEpAIBAAKCAQEA",
      "abcdefghijklmnop",
      "-----END RSA PRIVATE KEY-----",
      "'''",
    ].join("\n");
    const result = redactSecrets(code);
    expect(result.code).not.toContain("MIIEpAIBAAKCAQEA");
    expect(result.code.split("\n")).toHaveLength(code.split("\n").length);
  });

  it("masks a private key written on one line with escaped newlines", () => {
    const code = `KEY = "-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADAN\\n-----END PRIVATE KEY-----"`;
    expect(redactSecrets(code).code).toBe(
      `KEY = "-----BEGIN PRIVATE KEY-----[REDACTED]-----END PRIVATE KEY-----"`,
    );
  });

  it("leaves ordinary code untouched", () => {
    const code = "def total(items):\n    return sum(i.price for i in items)\n";
    expect(redactSecrets(code)).toEqual({ code, redactions: 0 });
  });
});
