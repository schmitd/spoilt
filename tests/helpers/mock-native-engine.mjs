// Browser integration mock lives only in the supported extension document.
// The production content -> background -> document messaging remains intact.
export async function openMockNativeEngine(context, extensionId, options = {}) {
  const page = await context.newPage();
  await page.addInitScript(({ delay, failCreate, rule, spoiler, imageMatch }) => {
    globalThis.__modelCalls = 0;
    globalThis.__modelInputs = [];
    globalThis.__modelCreates = 0;
    globalThis.__modelImageInputs = [];
    Object.defineProperty(globalThis, "LanguageModel", { configurable: true, value: {
      availability: async () => "available",
      create: async () => {
        globalThis.__modelCreates++;
        if (failCreate) throw new DOMException("The device is unable to create a session to run the model. Please check the result of availability() first.", "InvalidStateError");
        return { destroy() {}, prompt: async input => {
          globalThis.__modelCalls++;
          if (Array.isArray(input)) {
            const content = input.flatMap(message => Array.isArray(message.content) ? message.content : []);
            if (content.some(item => item.type === "text" && item.value.includes('{"ready":true}'))) return '{"ready":true}';
            for (const item of content.filter(item => item.type === "image")) {
              const bitmap = await createImageBitmap(item.value);
              const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height;
              const draw = canvas.getContext("2d"); draw.drawImage(bitmap, 0, 0);
              globalThis.__modelImageInputs.push({ type: item.value.type, bytes: item.value.size,
                width: bitmap.width, height: bitmap.height, pixel: [...draw.getImageData(0, 0, 1, 1).data] });
              bitmap.close();
            }
            return JSON.stringify({ block: imageMatch, rule });
          }
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
