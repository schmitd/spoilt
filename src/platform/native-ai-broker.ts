import { browser } from "wxt/browser";
import { SETTINGS_KEY } from "../core/settings";
import {
  HOST_PORT,
  NATIVE_SCOPE,
  validRequestId,
  validateNativeInput,
  validateNativeResponse,
  type NativeInput,
  type NativeResponse,
} from "../core/native-ai-protocol";
import { updateStatus } from "./storage";
import type { NativePriority } from "../core/native-job-queue";
import { MEMORY_KEY } from "../core/status";

const MAX_PENDING = 8;
const MAX_PENDING_PER_OWNER = 2;
const REQUEST_TIMEOUT_MS = 25_000;
const HOST_MISSING_REASON = "Open Prepare on-device analysis and keep Spoilt's analysis window open. Keyword protection remains active.";

interface BrokerOptions {
  runtimeId: string;
  hostUrl: string;
  reportUnavailable: () => void;
}

interface HostConnection {
  port: Browser.runtime.Port;
  tabId: number;
  onMessage: (message: unknown) => void;
  onDisconnect: () => void;
}

interface Owner {
  key: string;
  tabId: number;
}

interface PendingRequest {
  requestId: string;
  owner: Owner;
  input: NativeInput;
  host: HostConnection;
  resolve: (response: NativeResponse) => void;
  timeout: ReturnType<typeof setTimeout>;
  priority: NativePriority;
}

/** Holds raw inputs only while the owning document has a live, bounded request. */
export class NativeAiBroker {
  private host: HostConnection | null = null;
  private readonly pending = new Map<string, PendingRequest>();

  constructor(private readonly options: BrokerOptions) {}

  connect(port: Browser.runtime.Port): void {
    // Other extension features may use their own named ports.
    if (port.name !== HOST_PORT) return;
    const sender = port.sender;
    if (this.host || !sender || sender.id !== this.options.runtimeId
      || sender.url !== this.options.hostUrl
      || (sender.frameId !== undefined && sender.frameId !== 0)
      || !validTabId(sender.tab?.id)
      || (sender.tab?.url !== undefined && sender.tab.url !== this.options.hostUrl)) {
      disconnect(port);
      return;
    }
    const host: HostConnection = {
      port,
      tabId: sender.tab.id,
      onMessage: (message) => this.receive(host, message),
      onDisconnect: () => this.disconnectHost(host),
    };
    this.host = host;
    port.onMessage.addListener(host.onMessage);
    port.onDisconnect.addListener(host.onDisconnect);
    try { port.postMessage({ type: "connected" }); } catch { this.disconnectHost(host); }
  }

  handleMessage(message: unknown, sender: Browser.runtime.MessageSender): NativeResponse | Promise<NativeResponse> | undefined {
    if (!isRecord(message) || message.scope !== NATIVE_SCOPE) return undefined;
    const owner = this.owner(sender);
    if (!owner || !validRequestId(message.requestId)) return { ok: false, reason: "invalid" };
    if (message.type === "cancel") {
      for (const [internalId, request] of this.pending) {
        if (request.owner.key === owner.key && request.requestId === message.requestId) {
          this.finish(internalId, { ok: false, reason: "cancelled" }, true);
          break;
        }
      }
      // Give the same response whether or not this owner had a matching request.
      return { ok: false, reason: "cancelled" };
    }
    if (message.type !== "classify" || !validateNativeInput(message.input)) return { ok: false, reason: "invalid" };
    if (message.priority !== undefined && !["foreground", "background", "speculative"].includes(String(message.priority))) return { ok: false, reason: "invalid" };
    let ownerCount = 0;
    for (const request of this.pending.values()) {
      if (request.owner.key !== owner.key) continue;
      if (request.requestId === message.requestId) return { ok: false, reason: "invalid" };
      ownerCount++;
    }
    if (!this.host) {
      this.options.reportUnavailable();
      return { ok: false, reason: "unavailable" };
    }
    // Foreground preference is granted only to the browser-authenticated active tab.
    const priority: NativePriority = message.priority === "speculative" ? "speculative"
      : message.priority === "foreground" && sender.tab?.active === true ? "foreground" : "background";
    if (priority === "foreground") {
      for (const [id, pending] of this.pending) {
        if (pending.priority === "speculative") {
          if (pending.owner.key === owner.key) ownerCount--;
          this.finish(id, { ok: false, reason: "cancelled" }, true);
        }
      }
    }
    if (priority === "speculative" && this.pending.size > 0) return { ok: false, reason: "busy" };
    if (this.pending.size >= MAX_PENDING || ownerCount >= MAX_PENDING_PER_OWNER) return { ok: false, reason: "busy" };
    const host = this.host;
    const input = message.input;
    const requestId = message.requestId;
    let internalId = crypto.randomUUID();
    while (this.pending.has(internalId) || internalId === requestId) internalId = crypto.randomUUID();
    return new Promise<NativeResponse>((resolve) => {
      const timeout = setTimeout(() => this.finish(internalId, { ok: false, reason: "failed" }, true), REQUEST_TIMEOUT_MS);
      this.pending.set(internalId, { requestId, owner, input, host, resolve, timeout, priority });
      try {
        host.port.postMessage({ type: "classify", requestId: internalId, input,
          ...(message.priority !== undefined ? { priority } : {}) });
      } catch {
        this.disconnectHost(host);
      }
    });
  }

  invalidateTab(tabId: number): void {
    if (this.host?.tabId === tabId) this.disconnectHost(this.host);
    for (const [internalId, request] of this.pending) {
      if (request.owner.tabId === tabId) this.finish(internalId, { ok: false, reason: "cancelled" }, true);
    }
  }

  invalidateSettings(): void {
    for (const internalId of this.pending.keys()) this.finish(internalId, { ok: false, reason: "cancelled" }, true);
  }

  private owner(sender: Browser.runtime.MessageSender): Owner | null {
    if (sender.id !== this.options.runtimeId || sender.frameId !== 0 || !validTabId(sender.tab?.id) || !sender.url) return null;
    try {
      const url = new URL(sender.url);
      if (!/^https?:$/.test(url.protocol)) return null;
      if (sender.tab?.url !== undefined && new URL(sender.tab.url).origin !== url.origin) return null;
      const document = sender.documentId || url.href;
      return { key: JSON.stringify([sender.tab.id, document]), tabId: sender.tab.id };
    } catch {
      return null;
    }
  }

  private receive(host: HostConnection, message: unknown): void {
    if (this.host !== host || !isRecord(message) || message.type !== "result" || !validRequestId(message.requestId)) return;
    const request = this.pending.get(message.requestId);
    if (!request || request.host !== host) return;
    this.finish(message.requestId, validateNativeResponse(request.input, message.response)
      ? message.response
      : { ok: false, reason: "failed" });
  }

  private finish(internalId: string, response: NativeResponse, cancel = false): void {
    const request = this.pending.get(internalId);
    if (!request) return;
    this.pending.delete(internalId);
    clearTimeout(request.timeout);
    if (cancel) {
      try { request.host.port.postMessage({ type: "cancel", requestId: internalId }); } catch { /* A closed port already discards its work. */ }
    }
    request.resolve(response);
  }

  private disconnectHost(host: HostConnection): void {
    if (this.host !== host) return;
    this.host = null;
    host.port.onMessage.removeListener(host.onMessage);
    host.port.onDisconnect.removeListener(host.onDisconnect);
    for (const [internalId, request] of this.pending) {
      if (request.host === host) this.finish(internalId, { ok: false, reason: "unavailable" }, true);
    }
    disconnect(host.port);
    this.options.reportUnavailable();
  }
}

export function installNativeAiBroker(): void {
  const broker = new NativeAiBroker({
    runtimeId: browser.runtime.id,
    hostUrl: browser.runtime.getURL("/analysis.html"),
    reportUnavailable: () => {
      void updateStatus({ aiText: "unavailable", aiVision: "unavailable", aiReason: HOST_MISSING_REASON }).catch(() => undefined);
    },
  });
  browser.runtime.onConnect.addListener((port) => broker.connect(port));
  browser.runtime.onMessage.addListener((message: unknown, sender) => {
    const response = broker.handleMessage(message, sender);
    return response === undefined ? undefined : Promise.resolve(response);
  });
  browser.tabs.onUpdated.addListener((tabId, change) => {
    if (change.status === "loading" || change.url !== undefined) broker.invalidateTab(tabId);
  });
  browser.tabs.onRemoved.addListener((tabId) => broker.invalidateTab(tabId));
  browser.storage.onChanged.addListener((changes, area) => {
    if ((area === "sync" && changes[SETTINGS_KEY]) || (area === "local" && changes[MEMORY_KEY])) broker.invalidateSettings();
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validTabId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function disconnect(port: Browser.runtime.Port): void {
  try { port.disconnect(); } catch { /* It may already have disconnected. */ }
}
