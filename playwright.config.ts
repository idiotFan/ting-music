import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests",
  testMatch: "*.spec.ts",
  use: {
    baseURL: "http://127.0.0.1:1420",
    viewport: { width: 480, height: 720 },
    launchOptions: {
      executablePath:
        process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
        (existsSync(
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        )
          ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
          : undefined),
      args: ["--autoplay-policy=no-user-gesture-required"],
    },
  },
  workers: 1,
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:1420",
    reuseExistingServer: !process.env.CI,
  },
});
