import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../core/settings";
import { EMPTY_STATUS } from "../../core/status";
import { App } from "./App";

const { saveSettings, sendToActiveTab } = vi.hoisted(() => ({
  saveSettings: vi.fn(async (): Promise<void> => undefined),
  sendToActiveTab: vi.fn(async () => ({ ok: true })),
}));

vi.mock("wxt/browser", () => ({
  browser: { runtime: { openOptionsPage: vi.fn() } },
}));

vi.mock("../../platform/storage", () => ({
  loadSettings: vi.fn(async () => DEFAULT_SETTINGS),
  loadStatus: vi.fn(async () => ({
    ...EMPTY_STATUS,
    counters: { text: 3, images: 1, aiText: 0, aiImages: 0 },
  })),
  saveSettings,
}));

vi.mock("../../platform/messages", () => ({
  sendToActiveTab,
  refreshMemory: vi.fn(),
  getMemoryStatus: vi.fn(),
}));

vi.mock("../../services/local-ai", () => ({
  prepareLocalAi: vi.fn(),
}));

describe("popup app", () => {
  beforeEach(() => {
    saveSettings.mockClear();
    sendToActiveTab.mockClear();
  });

  it("prioritizes protection confidence and page activity", async () => {
    render(<App />);
    expect(await screen.findByText("4 items concealed on this page")).toBeTruthy();
    expect(screen.getByText("Your boundaries are on")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy();
  });

  it("keeps technical diagnostics collapsed by default", async () => {
    render(<App />);
    const summary = await screen.findByText("Protection details");
    const details = summary.closest("details");
    expect(details?.open).toBe(false);
    fireEvent.click(screen.getByText("Protection details"));
    expect(details?.open).toBe(true);
    expect(screen.getByText("Text analysis")).toBeTruthy();
  });

  it("uses the protection switch as the only reveal control", async () => {
    render(<App />);
    await screen.findByText("Your boundaries are on");
    expect(screen.queryByText("Reveal this page")).toBeNull();
    expect(screen.getByRole("checkbox", { name: "Pause protection" })).toBeTruthy();
  });

  it("coalesces rapid protection-toggle events into one settings write", async () => {
    let finishSave!: () => void;
    saveSettings.mockImplementationOnce(() => new Promise<void>((resolve) => { finishSave = resolve; }));
    render(<App />);
    const toggle = await screen.findByRole("checkbox", { name: "Pause protection" });

    fireEvent.change(toggle);
    fireEvent.change(toggle);
    fireEvent.change(toggle);

    expect(saveSettings).toHaveBeenCalledTimes(1);
    expect(toggle).toHaveProperty("disabled", true);
    finishSave();
    await waitFor(() => expect(toggle).toHaveProperty("disabled", false));
  });
});
