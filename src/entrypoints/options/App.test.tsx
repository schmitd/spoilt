import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../core/settings";
import { App } from "./App";

const { saveSettings } = vi.hoisted(() => ({ saveSettings: vi.fn() }));

vi.mock("../../platform/storage", () => ({
  loadSettings: vi.fn(async () => DEFAULT_SETTINGS),
  saveSettings,
}));

vi.mock("../../platform/messages", () => ({
  getMemoryStatus: vi.fn(),
}));

describe("options app", () => {
  beforeEach(() => saveSettings.mockClear());

  it("reveals dependent controls only when their parent feature is enabled", async () => {
    render(<App />);
    expect(await screen.findByText("Choose what reaches you")).toBeTruthy();
    expect(screen.getByText("Analyze images on this device")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: /Use on-device analysis/ }));
    expect(screen.queryByText("Analyze images on this device")).toBeNull();
  });

  it("supports removing and undoing a boundary", async () => {
    render(<App />);
    await screen.findByText("Choose what reaches you");
    fireEvent.click(screen.getByLabelText("Delete boundary"));
    expect(screen.getByText("No boundaries yet")).toBeTruthy();
    fireEvent.click(screen.getByText("Undo"));
    expect(screen.queryByText("No boundaries yet")).toBeNull();
  });

  it("saves a changed redaction style", async () => {
    render(<App />);
    await screen.findByText("Choose what reaches you");
    fireEvent.click(screen.getByLabelText("Marker"));
    fireEvent.click(screen.getByText("Save boundaries"));
    await waitFor(() => expect(saveSettings).toHaveBeenCalled());
    expect(saveSettings.mock.calls[0]?.[0].redactionStyle).toBe("marker");
  });

  it("adds keywords with space, Enter, and comma separators", async () => {
    render(<App />);
    await screen.findByText("Choose what reaches you");
    const input = screen.getByRole("textbox", { name: "Immediate keywords" });

    const entries = [
      { keyword: "champion", separator: " " },
      { keyword: "podium", separator: "Enter" },
      { keyword: "qualifying", separator: "," },
    ];
    for (const entry of entries) {
      fireEvent.input(input, { target: { value: entry.keyword } });
      fireEvent.keyDown(input, { key: entry.separator });
      expect(screen.getByText(entry.keyword)).toBeTruthy();
    }

    fireEvent.click(screen.getByText("Save boundaries"));
    await waitFor(() => expect(saveSettings).toHaveBeenCalled());
    expect(saveSettings.mock.calls.at(-1)?.[0].rules[0].keywords).toEqual(expect.arrayContaining([
      "champion",
      "podium",
      "qualifying",
    ]));
  });
});
