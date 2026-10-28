import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, SETTINGS_KEY } from "../../core/settings";
import { NATIVE_RETRY_KEY } from "../../core/native-ai-protocol";
import type { Settings } from "../../core/types";

const { syncGet, syncSet, localGet, localSet, addChangeListener, removeChangeListener, getCurrentWindow, updateWindow, disconnect, addPortMessageListener,
  getCurrentTab, addTabAttachmentListener, removeTabAttachmentListener } = vi.hoisted(() => ({
  syncGet: vi.fn(), syncSet: vi.fn(), localGet: vi.fn(), localSet: vi.fn(),
  addChangeListener: vi.fn(), removeChangeListener: vi.fn(),
  getCurrentWindow: vi.fn(), updateWindow: vi.fn(), disconnect: vi.fn(), addPortMessageListener: vi.fn(),
  getCurrentTab: vi.fn(), addTabAttachmentListener: vi.fn(), removeTabAttachmentListener: vi.fn(),
}));
vi.mock("wxt/browser", () => ({ browser: {
  runtime: { connect: () => ({ onMessage: { addListener: addPortMessageListener }, onDisconnect: { addListener: vi.fn() }, disconnect }) },
  storage: { sync: { get: syncGet, set: syncSet }, local: { get: localGet, set: localSet },
    onChanged: { addListener: addChangeListener, removeListener: removeChangeListener } },
  windows: { getCurrent: getCurrentWindow, update: updateWindow },
  tabs: { getCurrent: getCurrentTab, onAttached: { addListener: addTabAttachmentListener, removeListener: removeTabAttachmentListener } },
} }));

let settings: Settings;
let modelState: Record<"text" | "image", string>;
let model: { availability: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
let session: { prompt: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> };
const button = (kind: "text" | "image") => document.querySelector<HTMLButtonElement>(`#prepare-${kind}`)!;
const state = (kind: "text" | "image") => document.querySelector(`#${kind}-state`)!.textContent;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  settings = { ...DEFAULT_SETTINGS };
  modelState = { text: "available", image: "available" };
  syncGet.mockImplementation(async () => ({ [SETTINGS_KEY]: settings }));
  syncSet.mockResolvedValue(undefined);
  localGet.mockResolvedValue({});
  localSet.mockResolvedValue(undefined);
  getCurrentWindow.mockResolvedValue({ id: 91, type: "popup" });
  getCurrentTab.mockReset().mockResolvedValue({ id: 77 });
  updateWindow.mockResolvedValue({ id: 91, state: "minimized" });
  session = { prompt: vi.fn(async () => '{"ready":true}'), destroy: vi.fn() };
  model = {
    availability: vi.fn(async (options: LanguageModelCreateOptions) => modelState[options.expectedInputs.some((input) =>
      typeof input === "object" && input !== null && "type" in input && input.type === "image") ? "image" : "text"]),
    create: vi.fn(async () => session),
  };
  vi.stubGlobal("LanguageModel", model);
  document.body.innerHTML = readFileSync("src/entrypoints/analysis/index.html", "utf8");
});

afterEach(() => {
  window.dispatchEvent(new Event("pagehide"));
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

async function start() {
  await import("./main");
  await vi.waitFor(() => expect(state("image")).not.toBe("Checking availability."));
}

function changeSettings(patch: Partial<Settings>) {
  settings = { ...settings, ...patch };
  const listener = addChangeListener.mock.calls.at(-1)?.[0] as ((changes: Record<string, unknown>, area: string) => void) | undefined;
  listener?.({ [SETTINGS_KEY]: { newValue: settings } }, "sync");
}

describe("analysis preparation eligibility", () => {
  it.each(["useLocalAI", "useVision"] as const)("enables the existing page's buttons after %s is enabled", async (flag) => {
    settings = { ...settings, [flag]: false };
    await start();
    const existingButton = button("image");
    expect(existingButton.disabled).toBe(true);
    if (flag === "useLocalAI") expect(button("text").disabled).toBe(true);

    changeSettings({ [flag]: true });
    await vi.waitFor(() => expect(existingButton.disabled).toBe(false), { timeout: 300 });
    expect(button("image")).toBe(existingButton);
    expect(button("text").disabled).toBe(false);
    expect(state("image")).toContain("Model installed");
    expect(state("image")).not.toContain("Ready:");
    expect(model.create).not.toHaveBeenCalled();
    expect(session.prompt).not.toHaveBeenCalled();
    expect(updateWindow).not.toHaveBeenCalled();
  });

  it("refreshes changed model availability on focus without downloading or changing focus", async () => {
    await start();
    button("text").focus();
    modelState = { text: "unavailable", image: "downloadable" };
    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(button("text").disabled).toBe(true), { timeout: 300 });
    expect(button("image").disabled).toBe(false);
    expect(state("image")).toContain("Choose Prepare to consent");
    expect(document.activeElement).toBe(button("text"));
    expect(model.create).not.toHaveBeenCalled();
    expect(updateWindow).not.toHaveBeenCalled();
  });

  it("refreshes availability when a hidden document becomes visible", async () => {
    await start();
    model.availability.mockClear();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(model.availability).not.toHaveBeenCalled();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    modelState.text = "downloadable";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => expect(state("text")).toContain("Choose Prepare to consent"));
    expect(model.create).not.toHaveBeenCalled();
  });

  it.each(["useLocalAI", "useVision"] as const)("applies %s privacy changes immediately and ignores older availability results", async (flag) => {
    await start();
    const complete: Array<(value: string) => void> = [];
    model.availability.mockImplementation(() => new Promise<string>((resolve) => { complete.push(resolve); }));
    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(complete).toHaveLength(2));

    changeSettings({ [flag]: false });
    expect(button("image").disabled).toBe(true);
    if (flag === "useLocalAI") expect(button("text").disabled).toBe(true);
    complete.forEach((resolve) => resolve("available"));
    await Promise.resolve();
    await Promise.resolve();
    expect(button("image").disabled).toBe(true);
    expect(state("image")).toContain("Enable on-device analysis");
    expect(model.create).not.toHaveBeenCalled();
  });

  it("ignores startup settings that finish loading after a newer stored privacy change", async () => {
    let complete!: (value: unknown) => void;
    syncGet.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    await import("./main");
    changeSettings({ useLocalAI: false });
    complete({ [SETTINGS_KEY]: DEFAULT_SETTINGS });
    await vi.waitFor(() => expect(state("image")).toContain("Enable on-device analysis"));
    expect(button("text").disabled).toBe(true);
    expect(button("image").disabled).toBe(true);
    expect(model.availability).not.toHaveBeenCalled();
  });

  it("ignores out-of-order native model availability refreshes", async () => {
    await start();
    const complete: Array<(value: string) => void> = [];
    model.availability.mockImplementation(() => new Promise<string>((resolve) => { complete.push(resolve); }));
    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(complete).toHaveLength(2));
    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(complete).toHaveLength(4));
    complete[2]!("unavailable"); complete[3]!("downloadable");
    await vi.waitFor(() => expect(button("text").disabled).toBe(true));
    complete[0]!("available"); complete[1]!("available");
    await Promise.resolve();
    await Promise.resolve();
    expect(button("text").disabled).toBe(true);
    expect(state("image")).toContain("Choose Prepare to consent");
  });

  it("keeps create inside the explicit click and preserves preparation/readiness messages across focus checks", async () => {
    await start();
    let finishPrompt!: (value: string) => void;
    session.prompt.mockImplementation(() => new Promise((resolve) => { finishPrompt = resolve; }));
    expect(model.create).not.toHaveBeenCalled();
    button("text").click();
    expect(model.create).toHaveBeenCalledOnce();
    expect(button("text").disabled).toBe(true);
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledOnce());
    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(model.availability.mock.calls.length).toBeGreaterThan(2));
    expect(state("text")).toContain("Preparing and verifying locally");
    finishPrompt('{"ready":true}');
    await vi.waitFor(() => expect(state("text")).toContain("Ready: a local readiness prompt succeeded"));
    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(button("text").disabled).toBe(false));
    expect(state("text")).toContain("Ready: a local readiness prompt succeeded");
    expect(model.create).toHaveBeenCalledOnce();
    expect(updateWindow).not.toHaveBeenCalled();
  });

  it("removes passive listeners and ignores pending work after pagehide", async () => {
    await start();
    const complete: Array<(value: string) => void> = [];
    model.availability.mockImplementation(() => new Promise<string>((resolve) => { complete.push(resolve); }));
    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(complete).toHaveLength(2));
    window.dispatchEvent(new Event("pagehide"));
    model.availability.mockClear();
    complete.forEach((resolve) => resolve("unavailable"));
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
    await Promise.resolve();
    expect(state("text")).toContain("Model installed");
    expect(model.availability).not.toHaveBeenCalled();
    expect(removeChangeListener).toHaveBeenCalledWith(addChangeListener.mock.calls[0]![0]);
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("ignores late download progress and host connection messages after pagehide", async () => {
    await start();
    let progress!: (event: { loaded: number }) => void;
    model.create.mockImplementation(async (options: LanguageModelCreateOptions) => {
      options.monitor?.({ addEventListener: (_event, listener) => { progress = listener; } });
      return session;
    });
    session.prompt.mockImplementation(() => new Promise(() => undefined));
    button("text").click();
    expect(model.create).toHaveBeenCalledOnce();
    const beforeClose = state("text");
    const beforeConnection = document.querySelector("#connection")!.textContent;
    window.dispatchEvent(new Event("pagehide"));
    progress({ loaded: 0.5 });
    const receive = addPortMessageListener.mock.calls[0]![0] as (message: unknown) => void;
    receive({ type: "connected" });
    expect(state("text")).toBe(beforeClose);
    expect(document.querySelector("#connection")!.textContent).toBe(beforeConnection);
    expect(localSet.mock.calls.some(([value]) => NATIVE_RETRY_KEY in value)).toBe(false);
  });
});

describe("optional analysis window minimization", () => {
  const minimizeOption = () => document.querySelector<HTMLInputElement>("#minimize-after-setup")!;
  const windowStatus = () => document.querySelector("#window-state")!.textContent;

  it("starts unchecked and never minimizes after setup without the user's choice", async () => {
    await start();
    expect(minimizeOption().checked).toBe(false);
    expect(minimizeOption().disabled).toBe(false);
    button("text").click();
    await vi.waitFor(() => expect(state("text")).toContain("Ready:"));
    expect(updateWindow).not.toHaveBeenCalled();
  });

  it("minimizes only its own popup after the requested readiness prompt actually succeeds", async () => {
    await start();
    minimizeOption().checked = true;
    let finishPrompt!: (value: string) => void;
    session.prompt.mockImplementation(() => new Promise((resolve) => { finishPrompt = resolve; }));
    button("image").click();
    expect(model.create).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledOnce());
    expect(updateWindow).not.toHaveBeenCalled();
    finishPrompt('{"ready":true}');
    await vi.waitFor(() => expect(updateWindow).toHaveBeenCalledExactlyOnceWith(91, { state: "minimized" }));
    expect(windowStatus()).toContain("Restore this window");
    expect(state("image")).toContain("Ready:");
  });

  it.each(['{"ready":false}', "malformed output"])("does not minimize or claim ready after failed verification: %s", async (output) => {
    await start();
    minimizeOption().checked = true;
    session.prompt.mockResolvedValue(output);
    button("text").click();
    await vi.waitFor(() => expect(state("text")).toContain("Preparation could not be verified"));
    expect(updateWindow).not.toHaveBeenCalled();
    expect(state("text")).not.toContain("Ready:");
  });

  it("does not minimize a legacy analysis tab's normal browsing window", async () => {
    getCurrentWindow.mockResolvedValue({ id: 7, type: "normal" });
    await start();
    expect(minimizeOption().disabled).toBe(true);
    expect(windowStatus()).toContain("Automatic minimization is available only");
    // Even a stale or programmatically checked preference cannot bypass ownership.
    minimizeOption().checked = true;
    button("text").click();
    await vi.waitFor(() => expect(state("text")).toContain("Ready:"));
    expect(updateWindow).not.toHaveBeenCalled();
  });

  it("enables the option after an explicitly migrated analysis tab enters its dedicated popup", async () => {
    getCurrentWindow.mockResolvedValue({ id: 7, type: "normal" });
    await start();
    expect(minimizeOption().disabled).toBe(true);
    getCurrentWindow.mockResolvedValue({ id: 91, type: "popup" });
    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(minimizeOption().disabled).toBe(false));
    expect(minimizeOption().checked).toBe(false);
    expect(updateWindow).not.toHaveBeenCalled();
  });

  it("recognizes its own migrated tab without a DOM focus or visibility event", async () => {
    getCurrentWindow.mockResolvedValue({ id: 7, type: "normal" });
    await start();
    expect(minimizeOption().disabled).toBe(true);
    getCurrentWindow.mockClear().mockResolvedValue({ id: 91, type: "popup" });
    model.availability.mockClear();
    const attached = addTabAttachmentListener.mock.calls[0]?.[0] as ((tabId: number) => void) | undefined;
    attached?.(999);
    expect(getCurrentWindow).not.toHaveBeenCalled();
    attached?.(77);
    await vi.waitFor(() => expect(minimizeOption().disabled).toBe(false), { timeout: 300 });
    expect(getCurrentWindow).toHaveBeenCalledOnce();
    expect(minimizeOption().checked).toBe(false);
    expect(model.availability).not.toHaveBeenCalled();
    expect(model.create).not.toHaveBeenCalled();
    expect(updateWindow).not.toHaveBeenCalled();
  });

  it("catches a migration that occurs before its own tab identity finishes loading", async () => {
    let complete!: (value: unknown) => void;
    getCurrentTab.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    getCurrentWindow.mockResolvedValue({ id: 7, type: "normal" });
    await start();
    getCurrentWindow.mockResolvedValue({ id: 91, type: "popup" });
    const attached = addTabAttachmentListener.mock.calls[0]?.[0] as ((tabId: number) => void) | undefined;
    attached?.(77);
    complete({ id: 77 });
    await vi.waitFor(() => expect(minimizeOption().disabled).toBe(false), { timeout: 300 });
    expect(updateWindow).not.toHaveBeenCalled();
  });

  it("removes its exact-tab attachment listener and ignores late migration after pagehide", async () => {
    getCurrentWindow.mockResolvedValue({ id: 7, type: "normal" });
    await start();
    const attached = addTabAttachmentListener.mock.calls[0]?.[0] as ((tabId: number) => void) | undefined;
    window.dispatchEvent(new Event("pagehide"));
    getCurrentWindow.mockClear().mockResolvedValue({ id: 91, type: "popup" });
    attached?.(77);
    await Promise.resolve();
    expect(removeTabAttachmentListener).toHaveBeenCalledWith(attached);
    expect(getCurrentWindow).not.toHaveBeenCalled();
    expect(minimizeOption().disabled).toBe(true);
  });

  it("ignores an own-tab identity lookup that finishes after pagehide", async () => {
    let complete!: (value: unknown) => void;
    getCurrentTab.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    await start();
    window.dispatchEvent(new Event("pagehide"));
    getCurrentWindow.mockClear();
    complete({ id: 77 });
    await Promise.resolve();
    expect(getCurrentWindow).not.toHaveBeenCalled();
    expect(removeTabAttachmentListener).toHaveBeenCalledOnce();
  });

  it("keeps popup controls usable if its tab identity lookup fails", async () => {
    getCurrentTab.mockRejectedValueOnce(new Error("Tab identity unavailable"));
    await start();
    await vi.waitFor(() => expect(minimizeOption().disabled).toBe(false));
    expect(updateWindow).not.toHaveBeenCalled();
  });

  it.each([{ id: 7, type: "normal" }, { id: 92, type: "popup" }])("rechecks the owning window before minimizing: %j", async (current) => {
    await start();
    minimizeOption().checked = true;
    getCurrentWindow.mockResolvedValue(current);
    button("text").click();
    await vi.waitFor(() => expect(windowStatus()).toContain("This browser window will stay open"));
    expect(minimizeOption().disabled).toBe(true);
    expect(updateWindow).not.toHaveBeenCalled();
  });

  it("keeps setup usable when window controls are unavailable", async () => {
    getCurrentWindow.mockRejectedValue(new Error("Window controls unavailable"));
    await start();
    expect(minimizeOption().disabled).toBe(true);
    button("text").click();
    await vi.waitFor(() => expect(state("text")).toContain("Ready:"));
    expect(updateWindow).not.toHaveBeenCalled();
  });

  it("reports a minimize failure without turning successful readiness into a setup error", async () => {
    await start();
    minimizeOption().checked = true;
    updateWindow.mockRejectedValue(new Error("Unavailable"));
    button("text").click();
    await vi.waitFor(() => expect(windowStatus()).toContain("Chrome could not minimize this window automatically"));
    expect(state("text")).toContain("Ready:");
  });

  it("does not minimize when analysis is disabled during the final window ownership check", async () => {
    await start();
    minimizeOption().checked = true;
    let complete!: (value: unknown) => void;
    getCurrentWindow.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    button("text").click();
    await vi.waitFor(() => expect(getCurrentWindow).toHaveBeenCalledTimes(2));
    changeSettings({ useLocalAI: false });
    complete({ id: 91, type: "popup" });
    await vi.waitFor(() => expect(state("text")).toContain("Enable on-device analysis"));
    expect(updateWindow).not.toHaveBeenCalled();
  });
});
