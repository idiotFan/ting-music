import { test, expect, type Page } from "@playwright/test";

async function desktop(page: Page, width = 1400) {
  await page.setViewportSize({ width, height: 800 });
  await page.addInitScript(() => {
    const w = window as any;
    Object.defineProperty(window, "isTauri", { value: true });
    w.__panelCalls = [];
    const songs = Array.from({ length: 30 }, (_, i) => ({
      id: i + 1,
      name: `列宽歌曲 ${i + 1}`,
      artist: "测试歌手",
      album: "测试专辑",
      cover: "",
      duration: 20000,
      fee: 0,
    }));
    w.__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args: any = {}) => {
        if (cmd === "set_lyrics_panel") w.__panelCalls.push(args);
        if (cmd === "search_songs") return { songs, total: songs.length };
        if (cmd === "song_lyric") return "[00:00.00]列宽歌词";
        return null;
      },
    };
  });
  await page.goto("/");
  await expect(page.locator(".song-row")).toHaveCount(30);
}

const box = async (page: Page, selector: string) =>
  (await page.locator(selector).boundingBox())!;

async function settled(page: Page, selector: string) {
  await expect
    .poll(() =>
      page
        .locator(selector)
        .evaluate((el) =>
          el
            .getAnimations({ subtree: true })
            .every((a) => a.playState !== "running"),
        ),
    )
    .toBe(true);
}

async function drag(page: Page, selector: string, dx: number) {
  await settled(page, "#lyrics-panel");
  const handle = await box(page, selector);
  const x = handle.x + handle.width / 2;
  const y = handle.y + handle.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y);
  await page.mouse.move(x + dx, y);
  await page.mouse.up();
}

test("the player column can be dragged, stays within limits and persists", async ({
  page,
}) => {
  await desktop(page);
  const before = (await box(page, ".now-panel")).width;
  // Dragging the handle left widens the player column.
  await drag(page, "#player-resizer", -120);
  const wider = (await box(page, ".now-panel")).width;
  expect(Math.round(wider - before)).toBe(120);
  await drag(page, "#player-resizer", 2000);
  expect(Math.round((await box(page, ".now-panel")).width)).toBe(320);
  await drag(page, "#player-resizer", -2000);
  const max = (await box(page, ".now-panel")).width;
  expect(max).toBeLessThanOrEqual(640);
  expect((await box(page, "main")).width).toBeGreaterThanOrEqual(360);
  await drag(page, "#player-resizer", 100);
  const chosen = Math.round((await box(page, ".now-panel")).width);
  await page.reload();
  await expect(page.locator(".song-row")).toHaveCount(30);
  expect(Math.round((await box(page, ".now-panel")).width)).toBe(chosen);
  // Double-click restores the default.
  await page.locator("#player-resizer").dblclick();
  expect(Math.round((await box(page, ".now-panel")).width)).toBe(
    Math.round(before),
  );
  expect(
    await page.evaluate(() => localStorage.getItem("ting.columns.player")),
  ).toBe("");
});

test("the lyrics pane can be dragged and reports its width to the native window", async ({
  page,
}) => {
  await desktop(page);
  await page.locator(".song-row").first().dblclick();
  await page.locator("#lyrics-toggle").click();
  await expect(page.locator("#lyrics-panel")).toBeVisible();
  expect(await page.evaluate(() => (window as any).__panelCalls)).toEqual([
    { open: true, width: 320 },
  ]);
  const handle = page.locator("#lyrics-resizer");
  await expect(handle).toBeVisible();
  // The pane slides in and the player width is locked until it lands.
  await settled(page, "#lyrics-panel");
  await expect
    .poll(() =>
      page.locator("#app").evaluate((el) => el.getAttribute("style") || ""),
    )
    .toBe("");
  const list = (await box(page, "main")).width;
  const player = (await box(page, ".now-panel")).width;
  await drag(page, "#lyrics-resizer", -160);
  expect(Math.round((await box(page, "#lyrics-panel")).width)).toBe(480);
  expect(
    await page.evaluate(() =>
      document.documentElement.style.getPropertyValue("--lyrics-col"),
    ),
  ).toBe("480px");
  // The pane borrows from its neighbour: the player shrinks, the list stays.
  expect(Math.round((await box(page, ".now-panel")).width)).toBe(
    Math.round(player - 160),
  );
  expect(Math.abs((await box(page, "main")).width - list)).toBeLessThanOrEqual(
    1,
  );
  // Once the player is at its minimum the list gives way, but never below its own.
  await drag(page, "#lyrics-resizer", -600);
  expect(Math.round((await box(page, ".now-panel")).width)).toBe(320);
  expect((await box(page, "main")).width).toBeGreaterThanOrEqual(359);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - innerWidth,
    ),
  ).toBeLessThanOrEqual(0);
  await drag(page, "#lyrics-resizer", 2000);
  expect(Math.round((await box(page, "#lyrics-panel")).width)).toBe(260);
  // Keyboard: arrows move in 16px steps, Home/End jump to the limits.
  await handle.focus();
  await page.keyboard.press("ArrowLeft");
  expect(Math.round((await box(page, "#lyrics-panel")).width)).toBe(276);
  await page.keyboard.press("End");
  expect(Math.round((await box(page, "#lyrics-panel")).width)).toBe(260);
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.locator("#lyrics-toggle").click();
  await expect(page.locator("#lyrics-panel")).toBeHidden();
  await page.locator("#lyrics-toggle").click();
  // Reopening asks the window for the remembered width.
  expect(
    await page.evaluate(() => (window as any).__panelCalls.at(-1)),
  ).toEqual({
    open: true,
    width: 292,
  });
});

test("handles disappear where the columns stack", async ({ page }) => {
  await desktop(page, 800);
  await expect(page.locator("#player-resizer")).toBeHidden();
  await page.setViewportSize({ width: 1400, height: 800 });
  await expect(page.locator("#player-resizer")).toBeVisible();
  await page.locator(".song-row").first().dblclick();
  await page.locator("#lyrics-toggle").click();
  await expect(page.locator("#lyrics-resizer")).toBeVisible();
  await page.setViewportSize({ width: 1000, height: 800 });
  // Between 900 and 1239px the player stacks again under the lyrics pane.
  await expect(page.locator("#player-resizer")).toBeHidden();
  await expect(page.locator("#lyrics-resizer")).toBeVisible();
  await page.setViewportSize({ width: 700, height: 800 });
  await expect(page.locator("#lyrics-resizer")).toBeHidden();
});
