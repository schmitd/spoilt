// Browser integration mock lives only in the supported extension document.
// The production content -> background -> document messaging remains intact.
export async function openMockNativeEngine(context, extensionId, options = {}) {
  const page = await context.newPage();
  await page.addInitScript(({ delay, failCreate, rule, spoiler, imageMatch }) => {
    globalThis.__modelCalls = 0;
    globalThis.__modelInputs = [];
    globalThis.__modelCreates = 0;
    Object.defineProperty(globalThis, "LanguageModel", { configurable: true, value: {
      availability: async () => "available",
      create: async () => {
        globalThis.__modelCreates++;
        if (failCreate) throw new DOMException("The device is unable to create a session to run the model. Please check the result of availability() first.", "InvalidStateError");
        return { destroy() {}, prompt: async input => {
          globalThis.__modelCalls++;
          if (Array.isArray(input)) return JSON.stringify({ block: imageMatch, rule });
          const text = String(input);
          const items = JSON.parse(text.slice(text.lastIndexOf("Snippets:\n") + 10));
          globalThis.__modelInputs.push(items.map(item => item.text));
          await new Promise(resolve => setTimeout(resolve, delay));
          return JSON.stringify({ decisions: items.map(item => ({ i: item.i,
            block: item.text.startsWith(spoiler), rule })) });
        } };
      },
    } });
  }, { delay: options.delay ?? 0, failCreate: options.failCreate ?? false,
    rule: options.rule ?? "Story", spoiler: options.spoiler ?? "The captain quietly survives the battle",
    imageMatch: options.imageMatch ?? true });
  await page.goto(`chrome-extension://${extensionId}/analysis.html`);
  await page.locator('[data-native-host="connected"]').waitFor();
  return page;
}
