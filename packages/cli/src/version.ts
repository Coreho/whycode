// The CLI's own version, read from its package.json, for --version and for
// the tool field of --json reports.
import { readFileSync } from "node:fs";

/** The version in this package's package.json, one folder above src/ and dist/. */
export function cliVersion(): string {
  const packageJson: unknown = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  const version =
    typeof packageJson === "object" &&
    packageJson !== null &&
    "version" in packageJson
      ? packageJson.version
      : undefined;
  return typeof version === "string" ? version : "unknown";
}
