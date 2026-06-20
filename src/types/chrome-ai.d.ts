interface LanguageModelSession {
  prompt(input: unknown, options?: unknown): Promise<string>;
  destroy(): void;
}

interface LanguageModelMonitor {
  addEventListener(type: "downloadprogress", listener: (event: { loaded: number }) => void): void;
}

interface LanguageModelCreateOptions {
  expectedInputs: unknown[];
  expectedOutputs: unknown[];
  initialPrompts: unknown[];
  monitor?: (monitor: LanguageModelMonitor) => void;
}

interface LanguageModelStatic {
  availability(options: LanguageModelCreateOptions): Promise<string>;
  create(options: LanguageModelCreateOptions): Promise<LanguageModelSession>;
}

declare const LanguageModel: LanguageModelStatic | undefined;
