import { defineConfig } from "vite";
import { resolve } from "node:path";
// Tauri v2 desktop WebViews and the app's iOS 16 minimum support top-level await.
export default defineConfig({
  build: {
    target: ["safari16", "chrome105", "firefox115"],
    // The main app plus two small desktop windows (mini player, lyrics).
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        mini: resolve(__dirname, "mini.html"),
        lyrics: resolve(__dirname, "float-lyrics.html"),
      },
    },
  },
});
