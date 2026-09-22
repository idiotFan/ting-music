import { test, expect, type Page } from "@playwright/test";

async function desktopFixture(page: Page) {
  await page.addInitScript(() => {
    const w = window as any;
    Object.defineProperty(window, "isTauri", { value: true });
    const songs = Array.from({ length: 40 }, (_, i) => ({
      id: i + 1,
      name: `窗口歌曲 ${i + 1}`,
      artist: "测试歌手",
      album: "测试专辑",
      cover: "",
      duration: 20000,
      fee: 0,
    }));
    w.__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        if (cmd === "search_songs") return { songs, total: songs.length };
        if (cmd === "song_lyric") return "[00:00.00]测试歌词";
        return null;
      },
    };
  });
  await page.goto("/");
  await expect(page.locator(".song-row")).toHaveCount(40);
  await expect(page.locator("html")).not.toHaveClass(/mobile-device/);
}

async function boxes(page: Page) {
  const box = async (selector: string) =>
    (await page.locator(selector).boundingBox())!;
  return {
    header: await box(".app-header"),
    now: await box(".now-panel"),
    player: await box(".player"),
    nav: await box("nav"),
    main: await box("main"),
  };
}

test("desktop window splits into two columns when wide and stacks when narrow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await desktopFixture(page);
  let { header, now, player, nav, main } = await boxes(page);
  expect(header.x).toBe(0);
  expect(header.width).toBe(1280);
  expect(main.x + main.width).toBeLessThanOrEqual(now.x);
  expect(nav.x + nav.width).toBeLessThanOrEqual(now.x);
  expect(now.y + now.height).toBeLessThanOrEqual(player.y);
  expect(player.y + player.height).toBeLessThanOrEqual(800);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(1280);
  // A media-query-only switch never rebuilds the DOM or resets the list scroll.
  await page.locator(".main-scroll").evaluate((el) => (el.scrollTop = 120));
  for (const width of [760, 480]) {
    await page.setViewportSize({ width, height: 700 });
    ({ now, nav, main } = await boxes(page));
    expect(now.x).toBe(main.x);
    expect(main.y).toBeGreaterThanOrEqual(nav.y + nav.height);
    expect(
      await page.locator(".main-scroll").evaluate((el) => el.scrollTop),
    ).toBe(120);
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  ({ now, main } = await boxes(page));
  expect(main.x + main.width).toBeLessThanOrEqual(now.x);
  expect(
    await page.locator(".main-scroll").evaluate((el) => el.scrollTop),
  ).toBe(120);
});

test("desktop two columns leave room for the lyrics pane on the right", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 800 });
  await desktopFixture(page);
  await page.locator("#lyrics-toggle").click();
  await expect(page.locator("#lyrics-panel")).toBeVisible();
  await expect(page.locator("body")).toHaveClass(/lyrics-open/);
  // lyrics.ts locks #app's width until the open animation settles; the real
  // window widens meanwhile, so wait for the lock to release.
  await expect
    .poll(async () => (await page.locator("#lyrics-panel").boundingBox())!.x)
    .toBe(1280);
  const panel = (await page.locator("#lyrics-panel").boundingBox())!;
  expect(panel.width).toBe(320);
  const { now, player, main } = await boxes(page);
  // Still two columns: the app narrows to 1280px beside the lyrics pane.
  expect(main.x + main.width).toBeLessThanOrEqual(now.x);
  expect(player.x + player.width).toBeLessThanOrEqual(panel.x);
  const toggle = (await page.locator("#toggle").boundingBox())!;
  expect(toggle.x).toBeGreaterThanOrEqual(player.x);
  expect(toggle.x + toggle.width).toBeLessThanOrEqual(player.x + player.width);
  await page.screenshot({ path: "work/desktop-wide-lyrics.png" });
  await page.locator("#lyrics-close").click();
  await expect(page.locator("#lyrics-panel")).toBeHidden();
  await expect(page.locator("body")).not.toHaveClass(/lyrics-open/);
});

test("desktop lyrics pane below 1240px restores the stacked player", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 700 });
  await desktopFixture(page);
  await page.locator("#lyrics-toggle").click();
  await expect(page.locator("#lyrics-panel")).toBeVisible();
  await expect
    .poll(async () => (await page.locator("#lyrics-panel").boundingBox())!.x)
    .toBe(680);
  const panel = (await page.locator("#lyrics-panel").boundingBox())!;
  expect(panel.width).toBe(320);
  const { now, player, nav, main } = await boxes(page);
  // Single column inside the remaining 680px: playback sits above the list.
  expect(now.x).toBe(player.x);
  expect(main.y).toBeGreaterThanOrEqual(nav.y + nav.height);
  expect(player.x + player.width).toBeLessThanOrEqual(panel.x);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(1000);
  await page.locator("#lyrics-close").click();
  await expect(page.locator("#lyrics-panel")).toBeHidden();
});

test("the playback column is filled by the artwork instead of an empty middle", async ({
  page,
}) => {
  for (const [width, height] of [
    [900, 720],
    [1100, 620],
    [1400, 900],
  ]) {
    await page.setViewportSize({ width, height });
    await desktopFixture(page);
    const { now, player } = await boxes(page);
    const cover = (await page.locator("#now-cover").boundingBox())!;
    const heading = (await page.locator(".now-heading").boundingBox())!;
    expect(Math.abs(cover.width - cover.height)).toBeLessThanOrEqual(1);
    // Artwork leads the column; the title sits beneath it, not beside it.
    expect(cover.width).toBeGreaterThanOrEqual(now.width * 0.55);
    expect(heading.y).toBeGreaterThanOrEqual(cover.y + cover.height);
    expect(cover.y).toBeGreaterThanOrEqual(now.y);
    expect(heading.y + heading.height).toBeLessThanOrEqual(player.y);
    // No dead zone: artwork and title use most of the height above the controls.
    const used = heading.y + heading.height - cover.y;
    expect(used).toBeGreaterThanOrEqual(now.height * 0.7);
  }
  // The narrow window keeps the compact row with the title beside the cover.
  await page.setViewportSize({ width: 480, height: 720 });
  const cover = (await page.locator("#now-cover").boundingBox())!;
  const heading = (await page.locator(".now-heading").boundingBox())!;
  expect(cover.width).toBe(72);
  expect(heading.x).toBeGreaterThanOrEqual(cover.x + cover.width);
});

test("a landscape phone stacks the artwork above the title instead of leaving a gap", async ({
  browser,
}) => {
  for (const [width, height] of [
    [874, 402],
    [667, 375],
  ]) {
    const context = await browser.newContext({
      viewport: { width, height },
      isMobile: true,
      hasTouch: true,
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile",
    });
    const page = await context.newPage();
    await page.addInitScript(() => {
      const w = window as any;
      Object.defineProperty(window, "isTauri", { value: true });
      const songs = Array.from({ length: 20 }, (_, i) => ({
        id: i + 1,
        name: `横屏歌曲 ${i + 1}`,
        artist: "测试歌手",
        album: "测试专辑",
        cover: "",
        duration: 20000,
        fee: 0,
      }));
      w.__TAURI_INTERNALS__ = {
        invoke: async (cmd: string) =>
          cmd === "search_songs" ? { songs, total: songs.length } : null,
      };
    });
    await page.goto("/");
    await expect(page.locator(".song-row")).toHaveCount(20);
    const box = async (selector: string) =>
      (await page.locator(selector).boundingBox())!;
    const now = await box(".now-panel");
    const player = await box(".player");
    const cover = await box("#now-cover");
    const heading = await box(".now-heading");
    expect(cover.width).toBeGreaterThanOrEqual(70);
    expect(Math.abs(cover.width - cover.height)).toBeLessThanOrEqual(1);
    expect(heading.y).toBeGreaterThanOrEqual(cover.y + cover.height);
    expect(heading.width).toBeGreaterThanOrEqual(now.width * 0.5);
    expect(heading.y + heading.height).toBeLessThanOrEqual(player.y + 1);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - innerWidth,
      ),
    ).toBeLessThanOrEqual(0);
    await context.close();
  }
});
