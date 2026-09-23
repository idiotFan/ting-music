import { defineConfig } from "vite";
import { resolve } from "node:path";
const root = import.meta.dirname;
// Tauri v2 desktop WebViews and the app's iOS 16 minimum support top-level await.
export default defineConfig({
  build: {
    target: ["safari16", "chrome105", "firefox115"],
    // The main app plus two small desktop windows (mini player, lyrics).
    rollupOptions: {
      input: {
        main: resolve(root, "index.html"),
        mini: resolve(root, "mini.html"),
        lyrics: resolve(root, "float-lyrics.html"),
      },
    },
  },
});
