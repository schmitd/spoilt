import { describe, expect, it } from "vitest";
import { prefetchUrl } from "./link-prefetcher";
import { normalizeSettings } from "../core/settings";

const current = "https://example.com/start";
function link(href: string, attributes: Record<string, string> = {}) {
  const anchor = document.createElement("a");
  anchor.href = href;
  for (const [name, value] of Object.entries(attributes)) anchor.setAttribute(name, value);
  return anchor;
}

describe("link prefetch policy", () => {
  it("opts existing and new installations out until enabled", () => {
    expect(normalizeSettings({}).prefetchLinks).toBe(false);
    expect(normalizeSettings({ prefetchLinks: true }).prefetchLinks).toBe(true);
    expect(normalizeSettings({ prefetchLinks: "true" }).prefetchLinks).toBe(false);
  });
  it("includes ordinary new-tab links", () => {
    expect(prefetchUrl(link("https://example.com/article", { target: "_blank", rel: "noopener noreferrer" }), current)).toBe("https://example.com/article");
  });
  it("normalizes article fragments", () => {
    expect(prefetchUrl(link("https://example.com/article#heading"), current)).toBe("https://example.com/article");
  });
  it.each([
    "https://other.com/article", "http://example.com/article", "javascript:alert(1)",
    "https://example.com/start#heading", "https://example.com/search?q=hello",
    "https://example.com/logout", "https://example.com/account/%64elete",
    "https://example.com/report.pdf", "https://user:pass@example.com/article",
  ])("skips ineligible URL %s", (href) => {
    expect(prefetchUrl(link(href), current)).toBeNull();
  });
  it.each([{ download: "" }, { ping: "/track" }, { target: "named-frame" }, { rel: "nofollow" }, { "data-no-prefetch": "" }])("honors link exclusions %o", (attributes) => {
    expect(prefetchUrl(link("https://example.com/article", attributes), current)).toBeNull();
  });
});
