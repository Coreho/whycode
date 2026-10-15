// The CLI's connection to the outside world. Commands receive it as a
// parameter, so tests can run them without a real terminal or environment.
export interface CliIo {
  /** Directory that relative paths on the command line are resolved against. */
  cwd: string;
  /** Where API keys are read from. */
  env: Readonly<Record<string, string | undefined>>;
  /** Writes text to standard output as-is; callers add line breaks. */
  stdout(text: string): void;
  stderr(text: string): void;
  /** Whether standard output can show colors. */
  color: boolean;
}

export function processIo(): CliIo {
  const { stdout, stderr } = process;
  return {
    cwd: process.cwd(),
    env: process.env,
    stdout: (text) => void stdout.write(text),
    stderr: (text) => void stderr.write(text),
    // hasColors() exists only on terminals and honors NO_COLOR / FORCE_COLOR.
    color: stdout.isTTY && stdout.hasColors(),
  };
}
