// A hand-written stand-in for the parts of the VS Code API the extension
// uses. vitest.config.ts maps "vscode" to this file, so tests run the real
// extension code without VS Code. Tests script the user's answers and the
// language models through `fake`, and read back what the extension showed.

interface Disposable {
  dispose(): void;
}

const disposable: Disposable = { dispose: () => undefined };

export class Uri {
  private constructor(
    readonly scheme: string,
    readonly path: string,
    readonly query: string,
    readonly fsPath: string,
  ) {}

  static file(fsPath: string): Uri {
    return new Uri("file", fsPath.replace(/\\/g, "/"), "", fsPath);
  }

  with(change: { scheme?: string; query?: string }): Uri {
    return new Uri(
      change.scheme ?? this.scheme,
      this.path,
      change.query ?? this.query,
      this.fsPath,
    );
  }

  toString(): string {
    const query = this.query === "" ? "" : `?${this.query}`;
    return `${this.scheme}://${this.path}${query}`;
  }
}

export class TabInputTextDiff {
  constructor(
    readonly original: Uri,
    readonly modified: Uri,
  ) {}
}

export const ProgressLocation = { Notification: 15 } as const;

export class LanguageModelChatMessage {
  private constructor(readonly content: string) {}

  static User(content: string): LanguageModelChatMessage {
    return new LanguageModelChatMessage(content);
  }
}

interface QuickPickItem {
  label: string;
}

interface QuickPickOptions {
  title?: string;
  placeHolder?: string;
  canPickMany?: boolean;
}

/** Answers one quick pick: the chosen item(s), or undefined for Escape. */
export type QuickPickAnswer = (
  items: readonly QuickPickItem[],
  options: QuickPickOptions,
) => QuickPickItem | QuickPickItem[] | undefined;

export interface ShownMessage {
  kind: "info" | "warning" | "error";
  text: string;
  modal: boolean;
  buttons: string[];
}

export interface FakeChatModel {
  id: string;
  family: string;
  name: string;
  vendor: string;
  /** Every prompt this model was sent. */
  prompts: string[];
  sendRequest(
    messages: readonly LanguageModelChatMessage[],
  ): Promise<{ text: AsyncIterable<string> }>;
}

interface ContentProvider {
  provideTextDocumentContent(uri: Uri): string;
}

type Handler = (...args: unknown[]) => unknown;

interface FakeDocument {
  uri: Uri;
  isDirty: boolean;
}

class FakeOutputChannel {
  readonly lines: string[] = [];
  shown = false;

  appendLine(line: string): void {
    this.lines.push(line);
  }

  show(): void {
    this.shown = true;
  }

  dispose(): void {
    // Nothing to release.
  }
}

class FakeCancellation {
  isCancellationRequested = false;

  onCancellationRequested(): Disposable {
    return disposable;
  }
}

/** Test controls and records; reset() before each test. */
export const fake = {
  output: new FakeOutputChannel(),
  quickPickAnswers: [] as QuickPickAnswer[],
  quickPicks: [] as {
    title?: string;
    placeHolder?: string;
    labels: string[];
  }[],
  /** Which button the user presses on a message; undefined dismisses it. */
  answerMessage: (() => undefined) as (
    message: ShownMessage,
  ) => string | undefined,
  messages: [] as ShownMessage[],
  /** Every diff opened, with the proposal's content as the user saw it. */
  diffs: [] as { left: Uri; right: Uri; title: string; proposal: string }[],
  models: [] as FakeChatModel[],
  /** Settings the user set, by full key, e.g. "whycode.commentLevel". */
  settings: {} as Record<string, unknown>,
  workspaceFolders: [] as string[],
  documents: [] as FakeDocument[],
  activeFile: undefined as string | undefined,
  commands: new Map<string, Handler>(),
  contentProviders: new Map<string, ContentProvider>(),
  cancellation: new FakeCancellation(),

  reset(): void {
    this.output = new FakeOutputChannel();
    this.quickPickAnswers = [];
    this.quickPicks = [];
    this.answerMessage = () => undefined;
    this.messages = [];
    this.diffs = [];
    this.models = [];
    this.settings = {};
    this.workspaceFolders = [];
    this.documents = [];
    this.activeFile = undefined;
    this.commands = new Map();
    this.contentProviders = new Map();
    this.cancellation = new FakeCancellation();
  },

  /** Runs a registered command the way a menu or the palette would. */
  async runCommand(id: string, ...args: unknown[]): Promise<void> {
    const handler = this.commands.get(id);
    if (handler === undefined) throw new Error(`No command ${id}`);
    await handler(...args);
  },
};

/** Answers a quick pick with the first item whose label contains `text`. */
export function pick(text: string): QuickPickAnswer {
  return (items) => {
    const item = items.find((candidate) => candidate.label.includes(text));
    if (item === undefined) throw new Error(`No quick pick item "${text}"`);
    return item;
  };
}

/** Answers a multi-select quick pick with every item whose label contains one of `texts`. */
export function pickMany(...texts: string[]): QuickPickAnswer {
  return (items) =>
    items.filter((item) => texts.some((text) => item.label.includes(text)));
}

/** Presses Escape on a quick pick. */
export const dismiss: QuickPickAnswer = () => undefined;

/** A language model that answers each prompt with `reply`, streamed in two parts. */
export function fakeChatModel(
  info: { id: string; family?: string; name?: string; vendor?: string },
  reply: (prompt: string) => string,
): FakeChatModel {
  const prompts: string[] = [];
  return {
    family: info.id,
    name: info.id,
    vendor: "copilot",
    ...info,
    prompts,
    sendRequest(messages) {
      const prompt = messages.map((message) => message.content).join("\n");
      prompts.push(prompt);
      const text = reply(prompt);
      const middle = Math.floor(text.length / 2);
      return Promise.resolve({
        text: streamOf([text.slice(0, middle), text.slice(middle)]),
      });
    },
  };
}

async function* streamOf(parts: readonly string[]): AsyncIterable<string> {
  for (const part of parts) yield await Promise.resolve(part);
}

function showMessage(
  kind: ShownMessage["kind"],
  text: string,
  rest: readonly unknown[],
): Promise<string | undefined> {
  const modal = rest.some(
    (item) => typeof item === "object" && item !== null && "modal" in item,
  );
  const buttons = rest.filter((item) => typeof item === "string");
  const message = { kind, text, modal, buttons };
  fake.messages.push(message);
  return Promise.resolve(fake.answerMessage(message));
}

function isInside(path: string, folder: string): boolean {
  const normalize = (value: string) => value.replace(/\\/g, "/").toLowerCase();
  return (
    normalize(path).startsWith(`${normalize(folder)}/`) ||
    normalize(path) === normalize(folder)
  );
}

export const window = {
  get activeTextEditor() {
    const file = fake.activeFile;
    return file === undefined
      ? undefined
      : { document: { uri: Uri.file(file) } };
  },
  createOutputChannel: () => fake.output,
  showInformationMessage: (text: string, ...rest: unknown[]) =>
    showMessage("info", text, rest),
  showWarningMessage: (text: string, ...rest: unknown[]) =>
    showMessage("warning", text, rest),
  showErrorMessage: (text: string, ...rest: unknown[]) =>
    showMessage("error", text, rest),
  showQuickPick(
    items: readonly QuickPickItem[],
    options: QuickPickOptions,
  ): Promise<QuickPickItem | QuickPickItem[] | undefined> {
    fake.quickPicks.push({ ...options, labels: items.map((i) => i.label) });
    const answer = fake.quickPickAnswers.shift();
    if (answer === undefined) {
      throw new Error(`Unexpected quick pick: ${options.title ?? ""}`);
    }
    return Promise.resolve(answer(items, options));
  },
  withProgress<R>(
    _options: unknown,
    task: (
      progress: { report(value: unknown): void },
      token: FakeCancellation,
    ) => Promise<R>,
  ): Promise<R> {
    return task({ report: () => undefined }, fake.cancellation);
  },
  tabGroups: {
    all: [] as { tabs: { input: unknown }[] }[],
    close: () => Promise.resolve(true),
  },
};

export const workspace = {
  get textDocuments() {
    return fake.documents;
  },
  getWorkspaceFolder(uri: Uri) {
    const folder = fake.workspaceFolders.find((path) =>
      isInside(uri.fsPath, path),
    );
    return folder === undefined ? undefined : { uri: Uri.file(folder) };
  },
  getConfiguration(section: string) {
    const key = (name: string) => `${section}.${name}`;
    return {
      get: (name: string) => fake.settings[key(name)],
      inspect: (name: string) => ({ globalValue: fake.settings[key(name)] }),
    };
  },
  registerTextDocumentContentProvider(
    scheme: string,
    provider: ContentProvider,
  ): Disposable {
    fake.contentProviders.set(scheme, provider);
    return disposable;
  },
};

export const commands = {
  registerCommand(id: string, handler: Handler): Disposable {
    fake.commands.set(id, handler);
    return disposable;
  },
  executeCommand(id: string, ...args: unknown[]): Promise<unknown> {
    if (id === "vscode.diff") {
      const [left, right, title] = args as [Uri, Uri, string];
      const provider = fake.contentProviders.get(right.scheme);
      const proposal = provider?.provideTextDocumentContent(right) ?? "";
      fake.diffs.push({ left, right, title, proposal });
    }
    return Promise.resolve(undefined);
  },
};

export const lm = {
  selectChatModels: () => Promise.resolve(fake.models),
};
