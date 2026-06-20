import preact from "@preact/preset-vite";
import { defineConfig } from "wxt";

export default defineConfig({
  srcDir: "src",
  vite: () => ({
    plugins: [preact()],
  }),
  manifest: {
    name: "Spoilt",
    description: "Create healthy boundaries around spoilers and unwanted content.",
    version: "2.0.0",
    minimum_chrome_version: "138",
    permissions: ["storage", "activeTab", "alarms"],
    host_permissions: ["<all_urls>"],
    action: {
      default_title: "Spoilt",
      default_icon: {
        16: "icon/icon-16.png",
        32: "icon/icon-32.png",
        48: "icon/icon-48.png",
        128: "icon/icon-128.png",
      },
    },
    icons: {
      16: "icon/icon-16.png",
      32: "icon/icon-32.png",
      48: "icon/icon-48.png",
      128: "icon/icon-128.png",
    },
  },
});
