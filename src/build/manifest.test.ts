import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("generated extension manifest", () => {
  it("contains every release entrypoint after a production build", () => {
    const manifestPath = resolve(".output/chrome-mv3/manifest.json");
    if (!existsSync(manifestPath)) return;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, any>;
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.minimum_chrome_version).toBe("138");
    expect(manifest.background.service_worker).toBe("background.js");
    expect(manifest.content_scripts[0].js).toContain("content-scripts/content.js");
    expect(manifest.action.default_popup).toBe("popup.html");
    expect(manifest.options_page ?? manifest.options_ui?.page).toBe("options.html");
    expect(manifest.options_ui?.open_in_tab).toBe(true);
    expect(manifest.permissions).toEqual(expect.arrayContaining(["storage", "activeTab", "alarms"]));
  });
});
