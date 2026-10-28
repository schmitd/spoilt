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
      let notice: HTMLElement | undefined;
      const showNotice = (text: string) => {
        notice?.remove();
        notice = document.createElement("aside");
        notice.className = "spoilt-preparation-notice";
        notice.setAttribute("data-spoilt-ui", "");
        notice.setAttribute("role", "status");
        notice.append(document.createTextNode(text));
        const dismiss = document.createElement("button");
        dismiss.textContent = "Dismiss";
        dismiss.addEventListener("click", () => notice?.remove());
        notice.append(dismiss);
        (document.body || document.documentElement).append(notice);
      };
      const timer = window.setTimeout(() => {
        release();
        showNotice("Spoilt is still preparing protection. Unchecked content may be visible. ");
      }, 500);
      void new ContentController().start().then(() => notice?.remove()).catch(() => {
        showNotice("Spoilt could not start protection. Reload this page to retry. ");
      }).finally(() => {
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
