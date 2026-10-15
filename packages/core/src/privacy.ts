// Privacy guards applied before anything reaches an AI provider: refuse files
// that hold secrets outright, and mask secrets found inside ordinary code.
// Masking keeps every line in place, so AI line numbers still match the file.
import { posix } from "node:path";

const SENSITIVE_FILE_NAMES: readonly RegExp[] = [
  /^\.env($|\.)/i, // .env, .env.local, .env.production
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)/i, // SSH private keys
  /^\.(npmrc|pypirc|netrc)$/i, // often hold registry or login tokens
];

/** True for files that must never be sent to an AI, whatever their content. */
export function isSensitivePath(path: string): boolean {
  const fileName = posix.basename(path.replace(/\\/g, "/"));
  return SENSITIVE_FILE_NAMES.some((pattern) => pattern.test(fileName));
}

const REDACTED = "[REDACTED]";

// Well-known token formats. Anthropic comes before OpenAI because both start with "sk-".
const TOKEN_PATTERNS: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\b[rs]k_(?:live|test)_[0-9A-Za-z]{16,}\b/g,
];

// A quoted value assigned to a secret-sounding name: api_key = "...",
// "token": '...', password := "..." (Go) or secret = `...` (JavaScript).
const SECRET_ASSIGNMENT =
  /((?:api[_-]?key|secret|token|passw(?:or)?d)\w*["']?\s*(?::=|[:=])\s*)(["'`])([^"'`\n]{8,})\2/gi;

// An unquoted value that ends its line, as in shell scripts and env files:
// export API_TOKEN=abc... Brackets and parentheses rule out code such as
// token = get_token().
const UNQUOTED_SECRET_ASSIGNMENT =
  /^(\s*(?:export\s+)?\w*(?:api[_-]?key|secret|token|passw(?:or)?d)\w*\s*=\s*)([^\s"'`#;()[\]{},]{8,})(?=\s*$)/gim;

// The password in a URL such as postgres://user:password@host.
const URL_PASSWORD =
  /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@"'`]+:)([^\s@"'`/]+)(?=@)/gi;

// PEM private keys and PGP private key blocks.
const PRIVATE_KEY_BLOCK =
  /(-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----)([\s\S]*?)(-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----)/g;

export interface RedactionResult {
  code: string;
  redactions: number;
}

/** Masks likely secrets. The line count of the result always equals the input's. */
export function redactSecrets(code: string): RedactionResult {
  let redactions = 0;
  let result = code.replace(
    PRIVATE_KEY_BLOCK,
    (_block, begin: string, body: string, end: string) => {
      redactions += 1;
      return `${begin}${body.replace(/[^\n]+/g, REDACTED)}${end}`;
    },
  );
  for (const pattern of TOKEN_PATTERNS) {
    result = result.replace(pattern, () => {
      redactions += 1;
      return REDACTED;
    });
  }
  result = result.replace(
    SECRET_ASSIGNMENT,
    (match, prefix: string, quote: string, value: string) => {
      if (value === REDACTED) return match;
      redactions += 1;
      return `${prefix}${quote}${REDACTED}${quote}`;
    },
  );
  for (const pattern of [UNQUOTED_SECRET_ASSIGNMENT, URL_PASSWORD]) {
    result = result.replace(pattern, (match, prefix: string, value: string) => {
      if (value === REDACTED) return match;
      redactions += 1;
      return `${prefix}${REDACTED}`;
    });
  }
  return { code: result, redactions };
}
