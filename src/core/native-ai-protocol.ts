// This protocol accepts classification inputs, never caller-supplied prompts or settings.
export const NATIVE_SCOPE = "spoilt-native";
export const HOST_PORT = "spoilt-native-host";
// Operational nonce only; changing it asks existing pages to retry skipped candidates.
export const NATIVE_RETRY_KEY = "spoilt.native-retry";
export const MAX_TEXT_BATCH = 18;
export const MAX_TEXT_LENGTH = 600;
export const MAX_IMAGE_BYTES = 1_500_000;
export const MAX_DATA_URL_LENGTH = 2_000_050;

export interface ImageDecision { block: boolean; rule?: string; reason?: string }
export interface TextDecision extends ImageDecision { i: number }
export type NativeInput =
  | { kind: "text"; texts: string[] }
  | { kind: "image"; metadata: string; dataUrl: string }
  | { kind: "capabilities" };
export type NativeResponse =
  | { ok: true; decisions: TextDecision[] }
  | { ok: true; decision: ImageDecision | null }
  | { ok: true; text: boolean; image: boolean }
  | { ok: false; reason: "unavailable" | "busy" | "cancelled" | "invalid" | "failed" };

export function validRequestId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function validateNativeInput(value: unknown): value is NativeInput {
  if (!record(value)) return false;
  if (value.kind === "capabilities") return Object.keys(value).length === 1;
  if (value.kind === "text") return Object.keys(value).length === 2 && Array.isArray(value.texts)
    && value.texts.length > 0 && value.texts.length <= MAX_TEXT_BATCH
    && value.texts.every((text) => typeof text === "string" && text.length > 0 && text.length <= MAX_TEXT_LENGTH);
  return value.kind === "image" && Object.keys(value).length === 3
    && typeof value.metadata === "string" && value.metadata.length <= 1000
    && typeof value.dataUrl === "string" && value.dataUrl.length <= MAX_DATA_URL_LENGTH
    && /^data:image\/(?:png|jpeg|webp|gif|avif);base64,[A-Za-z0-9+/]+={0,2}$/.test(value.dataUrl);
}

export function validateNativeResponse(input: NativeInput, value: unknown): value is NativeResponse {
  if (!record(value) || typeof value.ok !== "boolean") return false;
  if (!value.ok) return ["unavailable", "busy", "cancelled", "invalid", "failed"].includes(String(value.reason));
  if (input.kind === "capabilities") return typeof value.text === "boolean" && typeof value.image === "boolean";
  if (input.kind === "image") return value.decision === null || validDecision(value.decision);
  if (!Array.isArray(value.decisions) || value.decisions.length > input.texts.length) return false;
  const seen = new Set<number>();
  return value.decisions.every((decision) => {
    if (!validDecision(decision) || !record(decision) || !Number.isInteger(decision.i)
      || (decision.i as number) < 0 || (decision.i as number) >= input.texts.length || seen.has(decision.i as number)) return false;
    seen.add(decision.i as number);
    return true;
  });
}

function validDecision(value: unknown): boolean {
  return record(value) && typeof value.block === "boolean"
    && (value.rule === undefined || (typeof value.rule === "string" && value.rule.length <= 200))
    && (value.reason === undefined || (typeof value.reason === "string" && value.reason.length <= 400));
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
