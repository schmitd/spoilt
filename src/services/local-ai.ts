import { updateStatus } from "../platform/storage";
import { withAiLease } from "../platform/ai-lease";
import type { Settings } from "../core/types";

const PREPARE_TIMEOUT_MS = 120_000;

export async function prepareLocalAi(settings: Settings): Promise<void> {
  await updateStatus({
    aiText: "checking",
    aiVision: settings.useVision ? "checking" : "fallback",
    aiReason: "Checking whether on-device analysis is ready.",
  });

  if (typeof LanguageModel === "undefined") {
    await updateStatus({
      aiText: "unavailable",
      aiVision: "fallback",
      aiReason: "On-device analysis is not available in this Chrome profile. Keyword protection remains active.",
    });
    return;
  }

  let textReady = false;
  try {
    await withAiLease("prepare", async () => {
      textReady = await prepareSession("text", {
        expectedInputs: [{ type: "text", languages: ["en"] }],
        expectedOutputs: [{ type: "text", languages: ["en"] }],
        initialPrompts: [{ role: "system", content: "Classify text against user-defined content boundaries." }],
      });

      if (settings.useVision) {
        await prepareSession("image", {
          expectedInputs: [{ type: "text", languages: ["en"] }, { type: "image" }],
          expectedOutputs: [{ type: "text", languages: ["en"] }],
          initialPrompts: [{ role: "system", content: "Classify images against user-defined content boundaries." }],
        });
      }
    });
  } catch {
    await updateStatus({
      aiText: "recovering",
      aiVision: settings.useVision ? "metadata fallback" : "fallback",
      aiReason: "On-device analysis is busy with another page. Spoilt will retry automatically.",
      lastError: "",
    });
    return;
  }

  await updateStatus({
    aiReason: textReady
      ? "On-device analysis is ready. Page content stays on this device."
      : "Keyword protection is active while on-device analysis remains unavailable.",
  });
}

async function prepareSession(kind: "text" | "image", options: LanguageModelCreateOptions): Promise<boolean> {
  const statusKey = kind === "text" ? "aiText" : "aiVision";
  try {
    const availability = await LanguageModel!.availability(options);
    if (availability === "unavailable") {
      await updateStatus({
        [statusKey]: kind === "image" ? "fallback" : "unavailable",
        aiReason: kind === "image"
          ? "Image protection is using captions and image descriptions."
          : "Text protection is using keywords and rule descriptions.",
      });
      return false;
    }

    const session = await withTimeout(LanguageModel!.create({
      ...options,
      monitor(monitor) {
        monitor.addEventListener("downloadprogress", ({ loaded }) => {
          void updateStatus({
            [statusKey]: "downloading",
            aiDownload: loaded,
            aiReason: `Preparing on-device ${kind} analysis: ${Math.round(loaded * 100)}%.`,
          });
        });
      },
    }), PREPARE_TIMEOUT_MS);
    session.destroy();
    await updateStatus({ [statusKey]: "available", aiDownload: undefined });
    return true;
  } catch (error) {
    if (isTransientSessionError(error)) {
      await updateStatus({
        [statusKey]: kind === "image" ? "metadata fallback" : "recovering",
        aiReason: `${kind === "image" ? "Image" : "Text"} analysis is busy. Spoilt will retry automatically.`,
        lastError: "",
      });
      return false;
    }
    await updateStatus({
      [statusKey]: kind === "image" ? "fallback" : "unavailable",
      aiReason: `${kind === "image" ? "Image" : "Text"} analysis could not be prepared. ${formatError(error)}`,
    });
    return false;
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutId = 0;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(() => reject(new Error("Preparation timed out.")), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => window.clearTimeout(timeoutId));
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTransientSessionError(error: unknown): boolean {
  const text = formatError(error).toLocaleLowerCase();
  return text.includes("aborterror")
    || text.includes("request was cancelled")
    || text.includes("unable to create a session");
}
