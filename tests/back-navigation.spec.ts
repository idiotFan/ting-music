import { test, expect, type Page } from "@playwright/test";

const phone = {
  viewport: { width: 393, height: 852 },
  isMobile: true,
  hasTouch: true,
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile",
};

async function setup(page: Page) {
  await page.addInitScript(() => {
    const w = window as any;
    Object.defineProperty(window, "isTauri", { value: true });
    w.__backCalls = [];
    const songs = Array.from({ length: 60 }, (_, i) => ({
      id: i + 1,
      name: `返回歌曲 ${i + 1}`,
      artist: "测试歌手",
      album: "测试专辑",
      cover: "",
      duration: 20000,
      fee: 0,
    }));
    localStorage.setItem("ting.playlist-filter", "netease");
    w.__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args: any = {}) => {
        const operation = cmd === "qq_request" ? args.operation : cmd;
        w.__backCalls.push({ operation });
        if (operation === "account_status")
          return { userId: 123, nickname: "测试账号", avatar: "" };
        if (operation === "search_songs") return { songs, total: songs.length };
        if (operation === "my_playlists")
          return {
            playlists: Array.from({ length: 24 }, (_, i) => ({
              id: i + 100,
              name: `返回歌单 ${i + 1}`,
              cover: "",
              trackCount: songs.length,
              creator: "测试账号",
              owned: true,
            })),
            more: false,
          };
        if (operation === "playlist_tracks") {
          if (w.__backHoldTracks)
            await new Promise<void>((resolve) => {
              w.__backReleaseTracks = resolve;
            });
          return { songs, total: songs.length, nextOffset: songs.length };
        }
        return null;
      },
    };
  });
  await page.goto("/");
  await expect(page.locator(".song-row")).toHaveCount(60);
}

async function openPlaylist(
  page: Page,
  key = "netease:114",
  name = "返回歌单 15",
) {
  await page.locator('[data-view="playlists"]').click();
  await expect(page.locator(".playlist-card")).toHaveCount(24);
  const card = page.locator(`[data-playlist="${key}"]`);
  await card.scrollIntoViewIfNeeded();
  await card.click();
  await expect(page.locator("#section-title")).toContainText(name);
  await expect(page.locator(".song-row")).toHaveCount(60);
}

const scrollTop = (page: Page) =>
  page.locator(".main-scroll").evaluate((el) => el.scrollTop);

// Synthetic touch swipe: the gesture module listens on document, so dispatch
// TouchEvents there with cancelable move/end phases.
function swipe(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
) {
  return page.evaluate(
    ({ from, to }) => {
      const id = 7;
      const touch = (x: number, y: number) =>
        new Touch({
          identifier: id,
          target: document.body,
          clientX: x,
          clientY: y,
        });
      const fire = (type: string, x: number, y: number, active: boolean) =>
        document.dispatchEvent(
          new TouchEvent(type, {
            touches: active ? [touch(x, y)] : [],
            changedTouches: [touch(x, y)],
            bubbles: true,
            cancelable: true,
          }),
        );
      fire("touchstart", from.x, from.y, true);
      const steps = 6;
      for (let i = 1; i <= steps; i++)
        fire(
          "touchmove",
          from.x + ((to.x - from.x) * i) / steps,
          from.y + ((to.y - from.y) * i) / steps,
          true,
        );
      fire("touchend", to.x, to.y, false);
    },
    { from, to },
  );
}

test("back button restores the list position and a new playlist still starts at the top", async ({
  browser,
}) => {
  const context = await browser.newContext(phone);
  const page = await context.newPage();
  await setup(page);
  await openPlaylist(page);
  const back = page.locator("#back-button");
  await expect(back).toBeVisible();
  await page.locator(".main-scroll").evaluate((el) => (el.scrollTop = 480));
  await back.tap();
  await expect(page.locator("#section-title")).toContainText("我的歌单");
  await expect(page.locator(".playlist-card")).toHaveCount(24);
  await expect(back).toBeHidden();
  // The list position saved before opening the detail view is restored.
  await expect.poll(() => scrollTop(page)).toBeGreaterThan(0);
  // Opening a different playlist still starts at the top, not at 480.
  await openPlaylist(page, "netease:115", "返回歌单 16");
  await expect.poll(() => scrollTop(page)).toBe(0);
  await context.close();
});

test("Escape on desktop leaves the playlist detail view", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await setup(page);
  await openPlaylist(page);
  await expect(page.locator("#back-button")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#section-title")).toContainText("我的歌单");
  await expect(page.locator(".playlist-card")).toHaveCount(24);
  await expect(page.locator("#back-button")).toBeHidden();
  // Escape elsewhere does nothing destructive.
  await page.keyboard.press("Escape");
  await expect(page.locator(".playlist-card")).toHaveCount(24);
  await context.close();
});

test("mobile back button is a 44px touch target with an accessible name", async ({
  browser,
}) => {
  const context = await browser.newContext(phone);
  const page = await context.newPage();
  await setup(page);
  await openPlaylist(page);
  const back = page.locator("#back-button");
  await expect(back).toHaveAttribute("aria-label", "返回歌单列表");
  const box = await back.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  expect(box!.width).toBeGreaterThanOrEqual(44);
  await context.close();
});

test("left-edge swipe goes back; vertical and non-edge swipes do not", async ({
  browser,
}) => {
  const context = await browser.newContext(phone);
  const page = await context.newPage();
  await setup(page);
  await openPlaylist(page);

  // Vertical scroll intent from the edge must not navigate.
  await swipe(page, { x: 10, y: 500 }, { x: 12, y: 200 });
  await expect(page.locator("#section-title")).toContainText("返回歌单 15");

  // A horizontal swipe starting outside the 24px edge zone is ignored.
  await swipe(page, { x: 200, y: 400 }, { x: 340, y: 402 });
  await expect(page.locator("#section-title")).toContainText("返回歌单 15");

  // A short edge swipe below the commit threshold snaps back in place.
  await swipe(page, { x: 8, y: 400 }, { x: 48, y: 400 });
  await expect(page.locator("#section-title")).toContainText("返回歌单 15");

  // A committed left-edge swipe performs the back navigation.
  await swipe(page, { x: 8, y: 400 }, { x: 160, y: 402 });
  await expect(page.locator("#section-title")).toContainText("我的歌单");
  await expect(page.locator(".playlist-card")).toHaveCount(24);
  await expect(page.locator("#back-button")).toBeHidden();
  await context.close();
});

test("a late playlist_tracks response cannot pollute the list after going back", async ({
  browser,
}) => {
  const context = await browser.newContext(phone);
  const page = await context.newPage();
  await setup(page);
  await page.evaluate(() => {
    (window as any).__backHoldTracks = true;
  });
  await page.locator('[data-view="playlists"]').tap();
  await expect(page.locator(".playlist-card")).toHaveCount(24);
  await page.locator('[data-playlist="netease:114"]').tap();
  await expect(page.locator("#section-title")).toContainText("返回歌单 15");
  // Tracks are still in flight; go back before the response arrives.
  await page.locator("#back-button").tap();
  await expect(page.locator("#section-title")).toContainText("我的歌单");
  await expect(page.locator(".playlist-card")).toHaveCount(24);
  await page.evaluate(() => (window as any).__backReleaseTracks());
  // The stale response is discarded by the serial guard, not rendered.
  await expect(page.locator(".playlist-card")).toHaveCount(24);
  await expect(page.locator("#songs")).toBeHidden();
  await expect(page.locator("#section-title")).toContainText("我的歌单");
  await context.close();
});

test("#back-button exists and is visible exactly in the playlist detail view", async ({
  browser,
}) => {
  const context = await browser.newContext(phone);
  const page = await context.newPage();
  await setup(page);
  // Hidden (and invisible to the Android offsetParent check) before opening.
  await expect(page.locator("#back-button")).toBeHidden();
  expect(
    await page.locator("#back-button").evaluate((el) => el.offsetParent),
  ).toBeNull();
  await openPlaylist(page);
  await expect(page.locator("#back-button")).toBeVisible();
  expect(
    await page.locator("#back-button").evaluate((el) => el.offsetParent),
  ).not.toBeNull();
  await context.close();
});
