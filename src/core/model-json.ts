export function parseModelJson<T extends object>(value: unknown): T {
  if (typeof value !== "string") return (value ?? {}) as T;
  const cleaned = stripMarkdownFence(value.trim());
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const jsonObject = extractFirstJsonObject(cleaned);
    if (!jsonObject) {
      if (cleaned.includes("{") || cleaned.includes("}")) throw new SyntaxError("Model returned malformed JSON.");
      return {} as T;
    }
    return JSON.parse(jsonObject) as T;
  }
}

function stripMarkdownFence(value: string): string {
  const match = value.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1]?.trim() ?? value;
}

function extractFirstJsonObject(value: string): string {
  const start = value.indexOf("{");
  if (start < 0) return "";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const char = value[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return value.slice(start, index + 1);
    }
  }
  return "";
}
