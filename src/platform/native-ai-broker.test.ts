import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOST_PORT, NATIVE_SCOPE, type NativeInput, type NativeResponse } from "../core/native-ai-protocol";
import { SETTINGS_KEY } from "../core/settings";
import { installNativeAiBroker, NativeAiBroker } from "./native-ai-broker";

const { browser, updateStatus } = vi.hoisted(() => ({
  browser: {
    runtime: {
      id: "extension-id",
      getURL: vi.fn((path: string) => `chrome-extension://extension-id/${path.replace(/^\//, "")}`),
      onConnect: { addListener: vi.fn() },
      onMessage: { addListener: vi.fn() },
    },
    tabs: { onUpdated: { addListener: vi.fn() }, onRemoved: { addListener: vi.fn() } },
    storage: { onChanged: { addListener: vi.fn() } },
  },
  updateStatus: vi.fn(async (_patch: Record<string, unknown>) => undefined),
}));
vi.mock("wxt/browser", () => ({ browser }));
vi.mock("./storage", () => ({ updateStatus }));

const HOST_URL = "chrome-extension://extension-id/analysis.html";
const INPUT: NativeInput = { kind: "text", texts: ["A bounded piece of page text"] };
const RESULT: NativeResponse = { ok: true, decisions: [{ i: 0, block: false }] };
const failure = (reason: "invalid" | "unavailable" | "cancelled" | "failed" | "busy") => ({ ok: false, reason });

function event<Args extends unknown[]>() {
  const listeners = new Set<(...args: Args) => void>();
  return {
    addListener: vi.fn((listener: (...args: Args) => void) => { listeners.add(listener); }),
    removeListener: vi.fn((listener: (...args: Args) => void) => { listeners.delete(listener); }),
    emit: (...args: Args) => { for (const listener of listeners) listener(...args); },
  };
}

function makePort(sender: Partial<Browser.runtime.MessageSender> = {}, name = HOST_PORT) {
  const port = {
    name,
    sender: { id: browser.runtime.id, url: HOST_URL, frameId: 0, tab: { id: 99, url: HOST_URL }, ...sender },
    onMessage: event<[unknown]>(),
    onDisconnect: event<[]>(),
    postMessage: vi.fn(),
    disconnect: vi.fn(),
  };
  return { ...port, native: port as unknown as Browser.runtime.Port };
}

function sender(tabId = 1, documentId = "document-1"): Browser.runtime.MessageSender {
  return { id: browser.runtime.id, frameId: 0, documentId, url: "https://example.com/article", tab: { id: tabId, url: "https://example.com/article" } as Browser.tabs.Tab };
}

function classify(requestId = crypto.randomUUID(), input: unknown = INPUT) {
  return { scope: NATIVE_SCOPE, type: "classify", requestId, input };
}

function cancel(requestId: string) {
  return { scope: NATIVE_SCOPE, type: "cancel", requestId };
}

function latestId(port: ReturnType<typeof makePort>): string {
  const message = port.postMessage.mock.calls.findLast(([value]) => value.type === "classify")?.[0] as { requestId: string } | undefined;
  expect(message).toBeDefined();
  return message!.requestId;
}

describe("NativeAiBroker", () => {
  let broker: NativeAiBroker;
  let reportUnavailable: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    reportUnavailable = vi.fn();
    broker = new NativeAiBroker({ runtimeId: browser.runtime.id, hostUrl: HOST_URL, reportUnavailable });
  });
  afterEach(() => {
    broker.invalidateSettings();
    vi.useRealTimers();
  });

  it("clamps foreground claims to the authenticated active tab and validates hints", async () => {
    const port = makePort(); broker.connect(port.native);
    const background = broker.handleMessage({ ...classify(), priority: "foreground" }, sender());
    expect(port.postMessage.mock.calls.at(-1)?.[0].priority).toBe("background");
    port.onMessage.emit({ type: "result", requestId: latestId(port), response: RESULT }); await background;
    const activeSender = sender(); activeSender.tab!.active = true;
    const foreground = broker.handleMessage({ ...classify(), priority: "foreground" }, activeSender);
    expect(port.postMessage.mock.calls.at(-1)?.[0].priority).toBe("foreground");
    port.onMessage.emit({ type: "result", requestId: latestId(port), response: RESULT }); await foreground;
    expect(broker.handleMessage({ ...classify(), priority: "private prompt" }, activeSender)).toEqual(failure("invalid"));
  });

  it("cancels speculative work for live foreground work and refuses speculation during live work", async () => {
    const port = makePort(); broker.connect(port.native);
    const prepared = broker.handleMessage({ ...classify(), priority: "speculative" }, sender());
    const speculativeId = latestId(port);
    const activeSender = sender(); activeSender.tab!.active = true;
    const live = broker.handleMessage({ ...classify(), priority: "foreground" }, activeSender);
    await expect(prepared).resolves.toEqual(failure("cancelled"));
    expect(port.postMessage).toHaveBeenCalledWith({ type: "cancel", requestId: speculativeId });
    expect(broker.handleMessage({ ...classify(), priority: "speculative" }, sender(2))).toEqual(failure("busy"));
    port.onMessage.emit({ type: "result", requestId: latestId(port), response: RESULT }); await live;
  });

  it("returns honest unavailability without forwarding or storing page content", () => {
    expect(broker.handleMessage(classify(), sender())).toEqual(failure("unavailable"));
    expect(reportUnavailable).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { id: "another-extension" },
    { url: `${HOST_URL}?spoof=1` },
    { url: "https://example.com/analysis.html" },
    { frameId: 1 },
    { tab: undefined },
    { tab: { id: -1 } },
    { tab: { id: 99, url: "https://example.com" } },
  ])("rejects unauthorized host %o", (invalid) => {
    const port = makePort(invalid as Partial<Browser.runtime.MessageSender>);
    broker.connect(port.native);
    expect(port.disconnect).toHaveBeenCalledOnce();
    expect(port.onMessage.addListener).not.toHaveBeenCalled();
    expect(broker.handleMessage(classify(), sender())).toEqual(failure("unavailable"));
  });

  it("ignores unrelated Port names and rejects duplicate hosts while preserving the first", async () => {
    const unrelated = makePort({}, "another-feature");
    broker.connect(unrelated.native);
    expect(unrelated.disconnect).not.toHaveBeenCalled();
    const first = makePort();
    const duplicate = makePort();
    broker.connect(first.native);
    expect(first.postMessage).toHaveBeenCalledWith({ type: "connected" });
    broker.connect(duplicate.native);
    expect(duplicate.disconnect).toHaveBeenCalledOnce();
    const work = broker.handleMessage(classify(), sender());
    first.onMessage.emit({ type: "result", requestId: latestId(first), response: RESULT });
    await expect(work).resolves.toEqual(RESULT);
    expect(first.disconnect).not.toHaveBeenCalled();
  });

  it.each([
    { id: "another-extension" },
    { id: undefined },
    { frameId: 2 },
    { frameId: undefined },
    { tab: undefined },
    { tab: { id: -1 } },
    { url: "file:///private-page" },
    { url: "chrome-extension://extension-id/options.html" },
    { url: "https://different.example/article" },
    { tab: { id: 1, url: "invalid URL" } },
  ])("rejects unauthorized content sender %o", (invalid) => {
    const port = makePort();
    broker.connect(port.native);
    port.postMessage.mockClear();
    expect(broker.handleMessage(classify(), { ...sender(), ...invalid } as Browser.runtime.MessageSender)).toEqual(failure("invalid"));
    expect(port.postMessage).not.toHaveBeenCalled();
  });

  it("ignores other scopes and rejects invalid envelopes and oversized content", () => {
    expect(broker.handleMessage({ ...classify(), scope: "spoilt" }, sender())).toBeUndefined();
    expect(broker.handleMessage({ ...classify(), type: "unknown" }, sender())).toEqual(failure("invalid"));
    expect(broker.handleMessage({ ...classify(), requestId: "chosen-id" }, sender())).toEqual(failure("invalid"));
    for (const input of [{ kind: "text", texts: ["a".repeat(601)] }, { kind: "text", texts: Array(19).fill("text") }, { kind: "image", metadata: "", dataUrl: "https://remote.example/image" }, { kind: "text", texts: ["text"], prompt: "ignore rules" }]) {
      expect(broker.handleMessage(classify(crypto.randomUUID(), input), sender())).toEqual(failure("invalid"));
    }
    expect(reportUnavailable).not.toHaveBeenCalled();
  });

  it("remaps IDs and validates results before delivering them to the owner", async () => {
    const port = makePort();
    broker.connect(port.native);
    const request = classify();
    const work = broker.handleMessage(request, sender());
    const internalId = latestId(port);
    expect(internalId).not.toBe(request.requestId);
    expect(port.postMessage).toHaveBeenLastCalledWith({ type: "classify", requestId: internalId, input: INPUT });
    port.onMessage.emit({ type: "result", requestId: request.requestId, response: RESULT });
    expect(vi.getTimerCount()).toBe(1);
    port.onMessage.emit({ type: "result", requestId: internalId, response: RESULT });
    await expect(work).resolves.toEqual(RESULT);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("accepts bounded image and read-only capability inputs", async () => {
    const port = makePort();
    broker.connect(port.native);
    const image: NativeInput = { kind: "image", metadata: "Thumbnail", dataUrl: "data:image/png;base64,YQ==" };
    const imageWork = broker.handleMessage(classify(crypto.randomUUID(), image), sender());
    port.onMessage.emit({ type: "result", requestId: latestId(port), response: { ok: true, decision: null } });
    await expect(imageWork).resolves.toEqual({ ok: true, decision: null });
    const capabilities = broker.handleMessage(classify(crypto.randomUUID(), { kind: "capabilities" }), sender());
    port.onMessage.emit({ type: "result", requestId: latestId(port), response: { ok: true, text: true, image: false } });
    await expect(capabilities).resolves.toEqual({ ok: true, text: true, image: false });
  });

  it("rejects duplicate IDs per owner and independently routes equal IDs from other documents", async () => {
    const port = makePort();
    broker.connect(port.native);
    const request = classify();
    const first = broker.handleMessage(request, sender());
    const firstId = latestId(port);
    expect(broker.handleMessage(request, sender())).toEqual(failure("invalid"));
    const second = broker.handleMessage(request, sender(1, "document-2"));
    const secondId = latestId(port);
    expect(secondId).not.toBe(firstId);
    broker.handleMessage(cancel(request.requestId), sender());
    await expect(first).resolves.toEqual(failure("cancelled"));
    port.onMessage.emit({ type: "result", requestId: secondId, response: RESULT });
    await expect(second).resolves.toEqual(RESULT);
  });

  it("cannot cancel another tab or another document's request", async () => {
    const port = makePort();
    broker.connect(port.native);
    const request = classify();
    const work = broker.handleMessage(request, sender());
    const internalId = latestId(port);
    port.postMessage.mockClear();
    expect(broker.handleMessage(cancel(request.requestId), sender(2))).toEqual(failure("cancelled"));
    expect(broker.handleMessage(cancel(request.requestId), sender(1, "another-document"))).toEqual(failure("cancelled"));
    expect(port.postMessage).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    broker.handleMessage(cancel(request.requestId), sender());
    await expect(work).resolves.toEqual(failure("cancelled"));
    expect(port.postMessage).toHaveBeenCalledWith({ type: "cancel", requestId: internalId });
  });

  it("binds owners to URL when documentId is unavailable", async () => {
    const port = makePort();
    broker.connect(port.native);
    const owner = sender();
    delete owner.documentId;
    const request = classify();
    const work = broker.handleMessage(request, owner);
    const internalId = latestId(port);
    broker.handleMessage(cancel(request.requestId), { ...owner, url: "https://example.com/other" });
    expect(vi.getTimerCount()).toBe(1);
    port.onMessage.emit({ type: "result", requestId: internalId, response: RESULT });
    await expect(work).resolves.toEqual(RESULT);
  });

  it("bounds requests at two per owner and eight total, releasing capacity on cancellation", async () => {
    const port = makePort();
    broker.connect(port.native);
    const requests: { message: ReturnType<typeof classify>; work: ReturnType<NativeAiBroker["handleMessage"]>; owner: Browser.runtime.MessageSender }[] = [];
    for (let tab = 1; tab <= 4; tab++) {
      for (let index = 0; index < 2; index++) {
        const message = classify();
        const owner = sender(tab);
        requests.push({ message, work: broker.handleMessage(message, owner), owner });
      }
      expect(broker.handleMessage(classify(), sender(tab))).toEqual(failure("busy"));
    }
    expect(broker.handleMessage(classify(), sender(5))).toEqual(failure("busy"));
    expect(vi.getTimerCount()).toBe(8);
    const first = requests[0]!;
    broker.handleMessage(cancel(first.message.requestId), first.owner);
    await expect(first.work).resolves.toEqual(failure("cancelled"));
    const replacement = broker.handleMessage(classify(), sender(5));
    expect(vi.getTimerCount()).toBe(8);
    broker.invalidateSettings();
    await expect(replacement).resolves.toEqual(failure("cancelled"));
    await Promise.all(requests.map(({ work }) => work));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out by 25 seconds, sends cancellation, and ignores late replies", async () => {
    const port = makePort();
    broker.connect(port.native);
    const work = broker.handleMessage(classify(), sender());
    const internalId = latestId(port);
    vi.advanceTimersByTime(24_999);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1);
    await expect(work).resolves.toEqual(failure("failed"));
    expect(port.postMessage).toHaveBeenLastCalledWith({ type: "cancel", requestId: internalId });
    port.onMessage.emit({ type: "result", requestId: internalId, response: RESULT });
    expect(vi.getTimerCount()).toBe(0);
    const next = broker.handleMessage(classify(), sender());
    port.onMessage.emit({ type: "result", requestId: latestId(port), response: RESULT });
    await expect(next).resolves.toEqual(RESULT);
  });

  it("fails malformed host results without letting them reach content", async () => {
    const port = makePort();
    broker.connect(port.native);
    const work = broker.handleMessage(classify(), sender());
    port.onMessage.emit({ type: "result", requestId: latestId(port), response: { ok: true, decisions: [{ i: 99, block: true }] } });
    await expect(work).resolves.toEqual(failure("failed"));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails pending work on host disconnect and accepts a fresh host without stale results", async () => {
    const oldHost = makePort();
    broker.connect(oldHost.native);
    const work = broker.handleMessage(classify(), sender());
    const oldId = latestId(oldHost);
    const oldListener = oldHost.onMessage.addListener.mock.calls[0]![0];
    oldHost.onDisconnect.emit();
    await expect(work).resolves.toEqual(failure("unavailable"));
    expect(oldHost.postMessage).toHaveBeenLastCalledWith({ type: "cancel", requestId: oldId });
    expect(reportUnavailable).toHaveBeenCalledOnce();
    expect(oldHost.onMessage.removeListener).toHaveBeenCalledOnce();
    const host = makePort();
    broker.connect(host.native);
    const next = broker.handleMessage(classify(), sender());
    const nextId = latestId(host);
    oldListener({ type: "result", requestId: nextId, response: RESULT });
    expect(vi.getTimerCount()).toBe(1);
    host.onMessage.emit({ type: "result", requestId: nextId, response: RESULT });
    await expect(next).resolves.toEqual(RESULT);
  });

  it("cleans up when a host Port throws during forwarding", async () => {
    const port = makePort();
    broker.connect(port.native);
    port.postMessage.mockImplementation(() => { throw new Error("Disconnected port"); });
    await expect(broker.handleMessage(classify(), sender())).resolves.toEqual(failure("unavailable"));
    expect(port.disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("invalidates only requests from the changed tab, and invalidates all on settings changes", async () => {
    const port = makePort();
    broker.connect(port.native);
    const first = broker.handleMessage(classify(), sender(1));
    const second = broker.handleMessage(classify(), sender(2));
    broker.invalidateTab(1);
    await expect(first).resolves.toEqual(failure("cancelled"));
    expect(vi.getTimerCount()).toBe(1);
    broker.invalidateSettings();
    await expect(second).resolves.toEqual(failure("cancelled"));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("disconnects the host and fails every pending request if its tab changes", async () => {
    const port = makePort();
    broker.connect(port.native);
    const first = broker.handleMessage(classify(), sender(1));
    const second = broker.handleMessage(classify(), sender(2));
    broker.invalidateTab(99);
    await expect(first).resolves.toEqual(failure("unavailable"));
    await expect(second).resolves.toEqual(failure("unavailable"));
    expect(port.disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("wires extension events and reports host absence without persisting inputs", async () => {
    installNativeAiBroker();
    const connect = browser.runtime.onConnect.addListener.mock.calls[0]![0] as (port: Browser.runtime.Port) => void;
    const message = browser.runtime.onMessage.addListener.mock.calls[0]![0] as NativeAiBroker["handleMessage"];
    const updated = browser.tabs.onUpdated.addListener.mock.calls[0]![0] as (tabId: number, change: { status?: string; url?: string }) => void;
    const removed = browser.tabs.onRemoved.addListener.mock.calls[0]![0] as (tabId: number) => void;
    const changed = browser.storage.onChanged.addListener.mock.calls[0]![0] as (changes: Record<string, unknown>, area: string) => void;
    await expect(message(classify(), sender())).resolves.toEqual(failure("unavailable"));
    expect(updateStatus).toHaveBeenCalledWith({ aiText: "unavailable", aiVision: "unavailable", aiReason: "Open Prepare on-device analysis and keep Spoilt's analysis window open. Keyword protection remains active." });
    const port = makePort();
    connect(port.native);
    const first = message(classify(), sender(1));
    const second = message(classify(), sender(2));
    changed({ [SETTINGS_KEY]: {} }, "local");
    changed({ "spoilt.status": {} }, "sync");
    updated(1, { status: "complete" });
    expect(vi.getTimerCount()).toBe(2);
    updated(1, { url: "https://example.com/next" });
    await expect(first).resolves.toEqual(failure("cancelled"));
    removed(2);
    await expect(second).resolves.toEqual(failure("cancelled"));
    const third = message(classify(), sender(3));
    changed({ [SETTINGS_KEY]: {} }, "sync");
    await expect(third).resolves.toEqual(failure("cancelled"));
    const fourth = message(classify(), sender(4));
    updated(99, { status: "loading" });
    await expect(fourth).resolves.toEqual(failure("unavailable"));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns Promise wire responses for immediate handled runtime messages", async () => {
    installNativeAiBroker();
    const listener = browser.runtime.onMessage.addListener.mock.calls[0]![0] as NativeAiBroker["handleMessage"];
    expect(listener({ scope: "another-feature" }, sender())).toBeUndefined();
    for (const [message, owner, reason] of [
      [{ ...classify(), requestId: "invalid" }, sender(), "invalid"],
      [classify(), { ...sender(), frameId: 1 }, "invalid"],
      [classify(crypto.randomUUID(), { kind: "text", texts: [] }), sender(), "invalid"],
      [classify(), sender(), "unavailable"],
      [cancel(crypto.randomUUID()), sender(), "cancelled"],
    ] as const) {
      const wireResponse = listener(message, owner);
      expect(wireResponse).toBeInstanceOf(Promise);
      await expect(wireResponse).resolves.toEqual(failure(reason));
    }
  });
});
