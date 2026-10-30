// A clone-aware synthetic model in the supported extension document. It never
// uses Chrome's native model; production messaging and DOM application stay live.
export async function openPerformanceEngine(context, extensionId, delays = {}) {
  const page = await context.newPage();
  await page.addInitScript(({ createMs, cloneMs, promptMs }) => {
    const stats = globalThis.__performanceModel = {
      creates: 0, clones: 0, baselinePrompts: 0, clonePrompts: 0,
      baselineDestroys: 0, cloneDestroys: 0, maxPriorPagePrompts: 0,
      activePrompts: 0, textBatchStarts: [], textBatches: [], imageInputs: [], fixedContextHadPageText: false, fixedContextHadLabel: false,
    };
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const session = (fixedContext, baseline, inherited = []) => {
      const history = [...inherited];
      let destroyed = false;
      return {
        async clone() {
          if (destroyed) throw new DOMException("Synthetic session closed", "InvalidStateError");
          stats.clones += 1;
          await wait(cloneMs);
          return session(fixedContext, false, history);
        },
        destroy() {
          if (destroyed) return;
          destroyed = true;
          stats[baseline ? "baselineDestroys" : "cloneDestroys"] += 1;
        },
        async prompt(input) {
          if (destroyed) throw new DOMException("Synthetic session closed", "InvalidStateError");
          stats[baseline ? "baselinePrompts" : "clonePrompts"] += 1;
          stats.maxPriorPagePrompts = Math.max(stats.maxPriorPagePrompts, history.length);
          history.push(input);
          stats.activePrompts += 1;
          try {
            let items;
            if (!Array.isArray(input)) {
              const text = String(input);
              const marker = "Snippets:\n";
              const index = text.lastIndexOf(marker);
              if (index < 0) throw new Error("Synthetic model received no snippet marker");
              items = JSON.parse(text.slice(index + marker.length));
              stats.textBatchStarts.push(items.map(item => item.text));
            }
            await wait(globalThis.__performancePromptDelayMs ?? promptMs);
            if (Array.isArray(input)) {
              const content = input.flatMap(message => Array.isArray(message.content) ? message.content : []);
              if (content.some(item => item.type === "text" && item.value.includes('{"ready":true}'))) return '{"ready":true}';
              for (const item of content.filter(item => item.type === "image")) {
                const bitmap = await createImageBitmap(item.value);
                const canvas = document.createElement("canvas");
                canvas.width = bitmap.width; canvas.height = bitmap.height;
                const draw = canvas.getContext("2d"); draw.drawImage(bitmap, 0, 0);
                stats.imageInputs.push({ bytes: item.value.size, type: item.value.type,
                  width: bitmap.width, height: bitmap.height, firstPixel: [...draw.getImageData(0, 0, 1, 1).data] });
                bitmap.close();
              }
              return '{"block":true,"rule":"boundary-1","reason":"Synthetic red square"}';
            }
            stats.textBatches.push(items.map(item => item.text));
            const beta = fixedContext.includes("Scenario criterion BETA_MODE");
            return JSON.stringify({ decisions: items.filter(item => item.text === (beta
              ? "Perf beta semantic outcome" : "Perf positive semantic outcome"))
              .map(item => ({ i: item.i, block: true, rule: "boundary-1", reason: "Synthetic semantic match" })) });
          } finally { stats.activePrompts -= 1; }
        },
      };
    };
    Object.defineProperty(globalThis, "LanguageModel", { configurable: true, value: {
      availability: async () => "available",
      create: async options => {
        stats.creates += 1;
        const fixedContext = JSON.stringify(options?.initialPrompts ?? []);
        stats.fixedContextHadPageText ||= /Perf (?:positive|harmless|beta|visible|newly|deferred)/.test(fixedContext);
        stats.fixedContextHadLabel ||= /AlphaBoundary|BetaBoundary|Renamed organizational category/.test(fixedContext);
        await wait(createMs);
        return session(fixedContext, true);
      },
    } });
  }, { createMs: delays.createMs ?? 40, cloneMs: delays.cloneMs ?? 5, promptMs: delays.promptMs ?? 40 });
  await page.goto(`chrome-extension://${extensionId}/analysis.html`);
  await page.locator('[data-native-host="connected"]').waitFor();
  return page;
}
