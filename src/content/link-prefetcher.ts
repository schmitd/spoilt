// Fetch from the content script so requests use the page's cache partition.
// Never render fetched HTML or intercept navigation; HTTP cache rules still apply.
const DWELL_MS = 120;
const MAX_REQUESTS = 8;
const MAX_BYTES = 1_000_000;
const TIMEOUT_MS = 5000;
const ACTION_PATH = /(?:^|[\/_.-])(?:logout|logoff|signout|sign-out|delete|remove|unsubscribe|checkout|purchase|cart|login|signin)(?:$|[\/_.-])/i;
const FILE_PATH = /\.(?!html?$)[a-z0-9]{1,8}$/i;

type Connection = EventTarget & { saveData?: boolean; effectiveType?: string };

export function prefetchUrl(anchor: HTMLAnchorElement, current: string): string | null {
  if (anchor.hasAttribute("download") || anchor.hasAttribute("ping")
    || anchor.closest('[data-no-prefetch], [contenteditable="true"], .spoilt-redaction')
    || /(?:^|\s)(?:nofollow|external)(?:\s|$)/i.test(anchor.rel)
    || (anchor.target && !["_self", "_blank"].includes(anchor.target.toLowerCase()))) return null;
  try {
    const url = new URL(anchor.href);
    const page = new URL(current);
    if (!/^https?:$/.test(url.protocol) || url.origin !== page.origin
      || url.username || url.password || url.search || ACTION_PATH.test(decodeURIComponent(url.pathname))
      || FILE_PATH.test(url.pathname)) return null;
    url.hash = "";
    page.hash = "";
    return url.href === page.href ? null : url.href;
  } catch { return null; }
}

export class LinkPrefetcher {
  constructor(private onHtml?: (url: string, html: string, signal: AbortSignal) => Promise<void>) {}
  #enabled = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #anchor: HTMLAnchorElement | null = null;
  #attempted = new Set<string>();
  #active: AbortController | null = null;
  #connection = (navigator as Navigator & { connection?: Connection }).connection;

  setEnabled(enabled: boolean): void {
    if (enabled === this.#enabled) return;
    this.#enabled = enabled;
    if (enabled) {
      document.addEventListener("pointerover", this.#intent);
      document.addEventListener("focusin", this.#intent);
      document.addEventListener("pointerout", this.#leave);
      document.addEventListener("focusout", this.#leave);
      document.addEventListener("visibilitychange", this.#conditionsChanged);
      window.addEventListener("pagehide", this.#cancel);
      window.addEventListener("offline", this.#cancel);
      this.#connection?.addEventListener("change", this.#conditionsChanged);
    } else {
      document.removeEventListener("pointerover", this.#intent);
      document.removeEventListener("focusin", this.#intent);
      document.removeEventListener("pointerout", this.#leave);
      document.removeEventListener("focusout", this.#leave);
      document.removeEventListener("visibilitychange", this.#conditionsChanged);
      window.removeEventListener("pagehide", this.#cancel);
      window.removeEventListener("offline", this.#cancel);
      this.#connection?.removeEventListener("change", this.#conditionsChanged);
      this.#cancel();
    }
  }

  #allowed = (): boolean => this.#enabled && !document.hidden && navigator.onLine
    && !this.#connection?.saveData && !/^(slow-2g|2g|3g)$/.test(this.#connection?.effectiveType ?? "");

  #conditionsChanged = (): void => { if (!this.#allowed()) this.#cancel(); };

  #cancel = (): void => {
    clearTimeout(this.#timer);
    this.#anchor = null;
    this.#active?.abort();
  };

  #intent = (event: Event): void => {
    if (!event.isTrusted || !this.#allowed() || this.#active) return;
    if (event instanceof PointerEvent && event.pointerType !== "mouse") return;
    const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!(anchor instanceof HTMLAnchorElement) || anchor === this.#anchor) return;
    clearTimeout(this.#timer);
    this.#anchor = anchor;
    this.#timer = setTimeout(() => {
      this.#anchor = null;
      if (!anchor.isConnected || !this.#allowed()) return;
      const url = prefetchUrl(anchor, location.href);
      if (url) void this.#fetch(url);
    }, DWELL_MS);
  };

  #leave = (event: Event): void => {
    const related = (event as MouseEvent | FocusEvent).relatedTarget;
    if (related instanceof Node && this.#anchor?.contains(related)) return;
    clearTimeout(this.#timer);
    this.#anchor = null;
  };

  async #fetch(url: string): Promise<void> {
    if (this.#active || this.#attempted.has(url) || this.#attempted.size >= MAX_REQUESTS) return;
    this.#attempted.add(url);
    const controller = new AbortController();
    this.#active = controller;
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        mode: "same-origin", credentials: "same-origin", redirect: "error",
        cache: "default", priority: "low", signal: controller.signal,
        headers: { Accept: "text/html,application/xhtml+xml" },
      });
      if (!response.ok || !/^(text\/html|application\/xhtml\+xml)(?:;|$)/i.test(response.headers.get("content-type") ?? "")
        || Number(response.headers.get("content-length")) > MAX_BYTES) {
        await response.body?.cancel();
        return;
      }
      const allowAnalysis = !/\bno-store\b/i.test(response.headers.get("cache-control") ?? "");
      const reader = response.body?.getReader();
      if (!reader) return;
      try {
        let bytes = 0;
        const decoder = new TextDecoder();
        let html = "";
        let complete = false;
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) { complete = true; break; }
          bytes += chunk.value.byteLength;
          if (bytes > MAX_BYTES) { await reader.cancel(); break; }
          if (allowAnalysis && this.onHtml) html += decoder.decode(chunk.value, { stream: true });
        }
        if (complete && allowAnalysis && this.onHtml && !controller.signal.aborted) {
          html += decoder.decode();
          clearTimeout(timeout);
          await this.onHtml(url, html, controller.signal);
        }
      } finally { reader.releaseLock(); }
    } catch {
      // Speculation is best effort; navigation and protection must remain unaffected.
    } finally {
      clearTimeout(timeout);
      if (this.#active === controller) this.#active = null;
    }
  }
}
