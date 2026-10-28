import "../content.css";
import { ContentController } from "../content/controller";

export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_start",
  main() {
    const begin = (): boolean => {
      const root = document.documentElement;
      if (!root) return false;
      // Cover the initial document while the tab's prepared result is checked.
      // Release promptly even if storage or the service worker is slow.
      if (document.contentType === "text/html") root.setAttribute("data-spoilt-preparing", "");
      const release = () => root.removeAttribute("data-spoilt-preparing");
      const timer = window.setTimeout(release, 500);
      void new ContentController().start().catch(() => undefined).finally(() => {
        window.clearTimeout(timer);
        release();
      });
      return true;
    };
    if (!begin()) {
      const observer = new MutationObserver(() => { if (begin()) observer.disconnect(); });
      observer.observe(document, { childList: true });
    }
  },
});
