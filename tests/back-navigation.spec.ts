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
      // Report what the release started, so a committed swipe can be checked
      // without racing its own 180ms exit.
      const library = document.querySelector<HTMLElement>(".library")!;
      const effect = library.getAnimations()[0]?.effect as
        KeyframeEffect | undefined;
      const frames = effect?.getKeyframes() ?? [];
      const last = frames[frames.length - 1];
      return {
        exit: String(last?.transform ?? ""),
        exitOpacity: String(last?.opacity ?? ""),
        settling: library.classList.contains("back-swipe-settle"),
      };
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

test("提交的返回手势把当前页送走，随后上一层补位且不残留内联样式", async ({
  browser,
}) => {
  const context = await browser.newContext(phone);
  const page = await context.newPage();
  await setup(page);
  await openPlaylist(page);
  const released = await swipe(page, { x: 8, y: 400 }, { x: 160, y: 402 });
  // The finger's promise is kept: the page keeps going right and fades out
  // instead of snapping back to where the drag started.
  expect(Number(/(-?[\d.]+)px/.exec(released.exit)?.[1])).toBeGreaterThan(0);
  expect(released.exitOpacity).toBe("0");
  expect(released.settling).toBe(false);
  await expect(page.locator("#section-title")).toContainText("我的歌单");
  await expect(page.locator(".playlist-card")).toHaveCount(24);
  await expect(page.locator("#back-button")).toBeHidden();
  await expect
    .poll(() =>
      page.locator(".library").evaluate((element) => ({
        transform: (element as HTMLElement).style.transform,
        opacity: (element as HTMLElement).style.opacity,
        settling: element.classList.contains("back-swipe-settle"),
      })),
    )
    .toEqual({ transform: "", opacity: "", settling: false });
  // The previous layer is usable straight away.
  await page.locator('[data-playlist="netease:101"]').tap();
  await expect(page.locator("#section-title")).toContainText("返回歌单 2");
  await context.close();
});

test("连续快速的未提交手势不会让上一次的回弹过渡提前解除", async ({
  browser,
}) => {
  const context = await browser.newContext(phone);
  const page = await context.newPage();
  await setup(page);
  await openPlaylist(page);
  // Both gestures, the gap between them and the measurement all live on the
  // page's own clock: a loaded machine stretches the settle timer and the gap
  // together, so the verdict never rides on wall-clock precision.
  const settle = await page.evaluate(async () => {
    const library = document.querySelector<HTMLElement>(".library")!;
    const touch = (x: number) =>
      new Touch({
        identifier: 7,
        target: document.body,
        clientX: x,
        clientY: 400,
      });
    const fire = (type: string, x: number, active: boolean) =>
      document.dispatchEvent(
        new TouchEvent(type, {
          touches: active ? [touch(x)] : [],
          changedTouches: [touch(x)],
          bubbles: true,
          cancelable: true,
        }),
      );
    // A short edge drag, released below the commit threshold.
    const nudge = () => {
      fire("touchstart", 8, true);
      for (let i = 1; i <= 6; i++) fire("touchmove", 8 + (40 * i) / 6, true);
      fire("touchend", 48, false);
    };
    nudge();
    const first = performance.now();
    // Timers fire in expiry order, so this always lands before the first
    // gesture's 220ms timer however far behind the event loop runs.
    await new Promise((resolve) =>
      setTimeout(resolve, 150 - (performance.now() - first)),
    );
    const pending = library.classList.contains("back-swipe-settle");
    nudge();
    const second = performance.now();
    const held = library.classList.contains("back-swipe-settle");
    const cleared = await new Promise<number>((resolve) => {
      let bail = 0;
      const done = () => {
        observer.disconnect();
        clearTimeout(bail);
        resolve(performance.now() - second);
      };
      const observer = new MutationObserver(() => {
        if (!library.classList.contains("back-swipe-settle")) done();
      });
      observer.observe(library, {
        attributes: true,
        attributeFilter: ["class"],
      });
      bail = window.setTimeout(done, 1500);
    });
    return { pending, held, cleared };
  });
  // The first gesture's rebound was still running when the second began…
  expect(settle.pending).toBe(true);
  expect(settle.held).toBe(true);
  // …and the class then lasted the second gesture's own 220ms instead of
  // being stripped by the first gesture's timer, which was due ~70ms in.
  expect(settle.cleared).toBeGreaterThan(200);
  expect(settle.cleared).toBeLessThan(1000);
  await expect(page.locator("#section-title")).toContainText("返回歌单 15");
  expect(
    await page
      .locator(".library")
      .evaluate((element) => (element as HTMLElement).style.transform),
  ).toBe("");
  await context.close();
});

test("大幅度的提交手势继续送出当前页，不会先往回弹一段", async ({
  browser,
}) => {
  const context = await browser.newContext(phone);
  const page = await context.newPage();
  await setup(page);
  await openPlaylist(page);
  // 8 → 300 on a 393px viewport: the finger alone carries the page past the
  // share of the width that the release increment may not exceed.
  const released = await swipe(page, { x: 8, y: 400 }, { x: 300, y: 402 });
  expect(
    Number(/(-?[\d.]+)px/.exec(released.exit)?.[1]),
  ).toBeGreaterThanOrEqual(292);
  expect(released.exitOpacity).toBe("0");
  await expect(page.locator("#section-title")).toContainText("我的歌单");
  await context.close();
});

test("另开一个歌单按全新内容推入，不沿用上一个歌单的滚动深度", async ({
  browser,
}) => {
  const context = await browser.newContext(phone);
  const page = await context.newPage();
  await setup(page);
  await openPlaylist(page);
  await page.locator(".main-scroll").evaluate((el) => (el.scrollTop = 480));
  await expect.poll(() => scrollTop(page)).toBeGreaterThan(0);
  // Leaving through a tab keeps the depth on record; the back button would
  // scroll the list to the top first by focusing itself.
  await page.locator('[data-view="favorites"]').tap();
  await expect(page.locator("#section-title")).toContainText("收藏");
  await page.locator('[data-view="playlists"]').tap();
  await expect(page.locator(".playlist-card")).toHaveCount(24);
  // The tab transition must finish first: an interrupted entrance continues
  // from the painted frame instead of declaring its own starting offset.
  await expect
    .poll(() =>
      page.evaluate(
        () => document.querySelector(".library")!.getAnimations().length,
      ),
    )
    .toBe(0);
  // Opening the card and reading the entrance in one turn: the animation is
  // created synchronously by the click, so nothing races its own 300ms.
  const push = await page.evaluate((key) => {
    document.querySelector<HTMLElement>(`[data-playlist="${key}"]`)!.click();
    const effect = document
      .querySelector(".library")!
      .getAnimations()
      .find((candidate) => candidate.effect instanceof KeyframeEffect)
      ?.effect as KeyframeEffect | undefined;
    const frames = effect?.getKeyframes() ?? [];
    return {
      offset: Number(
        /(-?[\d.]+)px/.exec(String(frames[0]?.transform ?? ""))?.[1] ?? NaN,
      ),
      duration: Number(effect?.getTiming().duration ?? NaN),
    };
  }, "netease:115");
  // A different playlist is genuinely new content, so it claims the full push
  // rather than the softer revisit implied by the last playlist's scroll.
  expect(push).toEqual({ offset: 28, duration: 300 });
  await expect(page.locator("#section-title")).toContainText("返回歌单 16");
  await expect.poll(() => scrollTop(page)).toBe(0);
  await context.close();
});
