import { test, expect } from "@playwright/test";
test("all eleven palettes cover the entire compact UI, preserve selection style and persist", async ({
  page,
}) => {
  await page.setViewportSize({ width: 400, height: 560 });
  await page.addInitScript(() => {
    const w = window as any;
    w.__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) =>
        cmd === "search_songs"
          ? {
              songs: [
                {
                  id: 1,
                  name: "天冷的时候我在想什么",
                  artist: "邹念慈",
                  album: "专辑",
                  cover: "",
                  duration: 232000,
                  fee: 0,
                },
                {
                  id: 2,
                  name: "红尘客栈",
                  artist: "周杰伦",
                  album: "十二新作",
                  cover: "",
                  duration: 274000,
                  fee: 0,
                },
              ],
              total: 2,
            }
          : null,
    };
    Object.defineProperty(window, "isTauri", { value: true });
  });
  await page.goto("/");
  await page.locator(".song-row").first().click();
  await page.locator("#theme-button").click();
  await expect(page.locator(".theme-choice")).toHaveCount(11);
  const ids = await page
    .locator("[data-theme-choice]")
    .evaluateAll((buttons) =>
      buttons.map((b) => (b as HTMLElement).dataset.themeChoice!),
    );
  const backgrounds = new Set();
  for (const id of ids) {
    await page.locator(`[data-theme-choice="${id}"]`).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", id);
    await page.locator("#theme-close").click();
    const info = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement),
        row = getComputedStyle(document.querySelector(".song-row.selected")!),
        body = getComputedStyle(document.querySelector("main")!);
      const c = document.createElement("canvas");
      c.width = c.height = 1;
      const ctx = c.getContext("2d")!;
      function luminance(color: string) {
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, 1, 1);
        const [r, g, b] = Array.from(ctx.getImageData(0, 0, 1, 1).data)
          .slice(0, 3)
          .map((v) => {
            v /= 255;
            return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
          });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      }
      function contrast(a: string, b: string) {
        const x = luminance(a),
          y = luminance(b);
        return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
      }
      return {
        bg: root.backgroundColor,
        shadow: row.boxShadow,
        inkContrast: contrast(root.color, body.backgroundColor),
        mutedContrast: contrast(
          getComputedStyle(document.querySelector(".song-info small")!).color,
          body.backgroundColor,
        ),
        overflow: document.documentElement.scrollWidth > innerWidth,
      };
    });
    expect(info.shadow).toBe("none");
    expect(info.inkContrast).toBeGreaterThan(4.5);
    expect(info.mutedContrast).toBeGreaterThan(4.5);
    expect(info.overflow).toBe(false);
    backgrounds.add(info.bg);
    await page.screenshot({ path: `work/theme-${id}.png` });
    await page.locator("#theme-button").click();
  }
  expect(backgrounds.size).toBe(11);
  await page.screenshot({ path: "work/theme-picker.png" });
  await page.locator("#theme-close").click();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "graphite");
  await expect(page.locator(".app-header")).toHaveAttribute(
    "data-tauri-drag-region",
    "",
  );
  expect(
    await page
      .locator(".brand")
      .evaluate((el) => el.getBoundingClientRect().left),
  ).toBeGreaterThanOrEqual(88);
});
