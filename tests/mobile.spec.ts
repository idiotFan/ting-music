import { test, expect } from "@playwright/test";

test("iPhone layout keeps controls in viewport and lyrics use a dismissible full screen sheet", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 393, height: 852 },
    isMobile: true,
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile",
  });
  const page = await context.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(window, "isTauri", { value: true });
    (window as any).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        if (cmd === "search_songs") return { songs: [], total: 0 };
        return null;
      },
    };
  });
  await page.goto("/");
  await expect(page.locator("html")).toHaveClass(/mobile-device/);
  await expect(page.locator("html")).not.toHaveClass(/mac-window/);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(393);
  await expect(page.locator("#quality")).toBeVisible();
  await page.locator("#lyrics-toggle").tap();
  const panel = page.locator("#lyrics-panel");
  await expect(panel).toBeVisible();
  const box = await panel.boundingBox();
  expect(box?.x).toBe(0);
  expect(box?.width).toBe(393);
  await page.locator("#lyrics-close").tap();
  await expect(panel).toBeHidden();
  await page.screenshot({ path: "work/ios-layout.png" });
  await context.close();
});

test("Mac title is centered and clears native traffic lights and account controls", async ({
  page,
}) => {
  await page.setViewportSize({ width: 400, height: 720 });
  await page.addInitScript(() => {
    Object.defineProperty(window, "isTauri", { value: true });
    Object.defineProperty(navigator, "platform", { value: "MacIntel" });
    Object.defineProperty(navigator, "maxTouchPoints", { value: 0 });
    (window as any).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) =>
        cmd === "search_songs" ? { songs: [], total: 0 } : null,
    };
  });
  await page.goto("/");
  const brand = await page.locator(".brand").boundingBox();
  const theme = await page.locator("#theme-button").boundingBox();
  expect(Math.abs(brand!.x + brand!.width / 2 - 200)).toBeLessThan(1);
  expect(brand!.x).toBeGreaterThan(88);
  expect(brand!.x + brand!.width).toBeLessThan(theme!.x);
  await expect(page.locator(".brand-mark")).toBeHidden();
  await page.screenshot({ path: "work/mac-titlebar-layout.png" });
});
