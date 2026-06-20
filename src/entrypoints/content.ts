import "../content.css";
import { ContentController } from "../content/controller";

export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_idle",
  main() {
    void new ContentController().start();
  },
});
