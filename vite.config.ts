import { defineConfig } from "vite";
// Tauri v2 desktop WebViews and the app's iOS 16 minimum support top-level await.
export default defineConfig({
  build: { target: ["safari16", "chrome105", "firefox115"] },
});
