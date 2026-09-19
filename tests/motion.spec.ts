import { test, expect, type Page, type Route } from "@playwright/test";
import { PNG } from "pngjs";

const coverUrl = (id: number) => `https://motion.test/cover-${id}.png`;
const coverPng = (id: number) => {
  const png = new PNG({ width: 32, height: 32 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = id === 1 ? 220 : 40;
    png.data[i + 1] = id === 2 ? 180 : 40;
    png.data[i + 2] = id === 3 ? 220 : 40;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
};

async function fixture(
  page: Page,
  heldCovers: number[] = [],
  failedCovers: number[] = [],
) {
  const released = new Set<number>();
  const failed = new Set(failedCovers);
  const waiting = new Map<number, Route[]>();
  const send = (route: Route, id: number) =>
    route.fulfill({ contentType: "image/png", body: coverPng(id) });
  await page.route("https://motion.test/cover-*.png", async (route) => {
    const id = Number(/cover-(\d+)/.exec(route.request().url())![1]);
    if (failed.has(id)) {
      await route.abort("failed");
      return;
    }
    if (heldCovers.includes(id) && !released.has(id)) {
      waiting.set(id, [...(waiting.get(id) || []), route]);
      return;
    }
    await send(route, id);
  });
  await page.addInitScript(() => {
    const w = window as any;
    Object.defineProperty(window, "isTauri", { value: true });
    const songs = [1, 2, 3].map((id) => ({
      id,
      name: `动画歌曲 ${id}`,
      artist: "动画测试歌手",
      album: `动画专辑 ${id}`,
      cover: `https://motion.test/cover-${id}.png`,
      duration: 30000,
      fee: 0,
    }));
    localStorage.setItem("ting.favorites", JSON.stringify([songs[0]]));
    localStorage.setItem("ting.playlist-filter", "netease");
    const wav = new ArrayBuffer(44 + 22050 * 30 * 2);
    const data = new DataView(wav);
    const text = (offset: number, value: string) =>
      [...value].forEach((character, i) =>
        data.setUint8(offset + i, character.charCodeAt(0)),
      );
    text(0, "RIFF");
    data.setUint32(4, wav.byteLength - 8, true);
    text(8, "WAVEfmt ");
    data.setUint32(16, 16, true);
    data.setUint16(20, 1, true);
    data.setUint16(22, 1, true);
    data.setUint32(24, 22050, true);
    data.setUint32(28, 44100, true);
    data.setUint16(32, 2, true);
    data.setUint16(34, 16, true);
    text(36, "data");
    data.setUint32(40, wav.byteLength - 44, true);
    const url = URL.createObjectURL(new Blob([wav], { type: "audio/wav" }));
    w.__motionCalls = [];
    w.__TAURI_INTERNALS__ = {
      invoke: async (command: string, args: any = {}) => {
        const operation = command === "qq_request" ? args.operation : command;
        const source = command === "qq_request" ? "qq" : "netease";
        w.__motionCalls.push({ operation, source });
        if (operation === "account_status")
          return { userId: 123, nickname: "动画测试账号", avatar: "" };
        if (operation === "search_songs") {
          if (args.query === "延迟搜索")
            await new Promise<void>((resolve) => {
              w.__motionFinishSearch = resolve;
            });
          return { songs, total: songs.length };
        }
        if (operation === "my_playlists") {
          if (w.__motionHoldPlaylists)
            await new Promise<void>((resolve) => {
              w.__motionFinishPlaylists.push(resolve);
            });
          return {
            playlists: songs.map((song) => ({
              id: song.id,
              name: `动画歌单 ${song.id}`,
              creator: "动画测试账号",
              cover: song.cover,
              trackCount: songs.length,
              owned: true,
            })),
            more: false,
          };
        }
        if (operation === "playlist_tracks") {
          if (w.__motionHoldTracks)
            await new Promise<void>((resolve) => {
              w.__motionFinishTracks = resolve;
            });
          const tracks = w.__motionPlaylistSongs || songs;
          return {
            songs: tracks,
            total: tracks.length,
            nextOffset: tracks.length,
          };
        }
        if (operation === "playlist_edit") {
          const tracks = w.__motionPlaylistSongs || songs;
          if (args.action === "remove")
            w.__motionPlaylistSongs = tracks.filter(
              (song: any) => song.id !== args.trackId,
            );
          return null;
        }
        if (operation === "song_url")
          return {
            url,
            level: "standard",
            trial: false,
            trialStart: 0,
            format: "wav",
            bitrate: 128000,
          };
        if (operation === "song_lyric")
          return "[00:00.00]第一句歌词\n[00:04.00]第二句歌词\n[00:08.00]第三句歌词";
        return null;
      },
    };
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".song-row")).toHaveCount(3);
  await expect(page.locator("#account-name")).toHaveText("双账号");
  return {
    recoverCover: (id: number) => failed.delete(id),
    releaseCover: async (id: number) => {
      released.add(id);
      await Promise.all(
        (waiting.get(id) || []).map((route) => send(route, id)),
      );
      waiting.delete(id);
    },
  };
}

async function rememberNodes(page: Page, selector: string) {
  await page.evaluate((selector) => {
    (window as any).__motionNodes = [...document.querySelectorAll(selector)];
  }, selector);
}

async function expectSameNodes(page: Page, selector: string) {
  expect(
    await page.evaluate((selector) => {
      const before = (window as any).__motionNodes as Element[];
      const after = [...document.querySelectorAll(selector)];
      return (
        before.length === after.length &&
        before.every((node, index) => node.isConnected && node === after[index])
      );
    }, selector),
  ).toBe(true);
}

async function expectResting(page: Page, selector: string) {
  await expect(page.locator(selector)).toBeVisible();
  await expect
    .poll(() =>
      page.locator(selector).evaluate((element) => {
        const style = getComputedStyle(element);
        return (
          Number(style.opacity) === 1 &&
          style.visibility === "visible" &&
          element.getAnimations({ subtree: true }).every((animation) => {
            const iterations = animation.effect?.getTiming().iterations;
            return (
              iterations === Infinity ||
              (!animation.pending && animation.playState !== "running")
            );
          })
        );
      }),
    )
    .toBe(true);
}

test("selection, favorites, queue updates and playback keep existing song covers mounted", async ({
  page,
}) => {
  await fixture(page);
  await expectResting(page, "#songs");
  await rememberNodes(page, ".song-row, .song-row img");
  await page.locator(".song-row").nth(1).click();
  await page.locator('[data-favorite="netease:2"]').click();
  await page.locator('[data-enqueue="netease:2"]').click();
  await page.locator(".song-row").first().dblclick();
  await expect(page.locator("#toggle")).toHaveAttribute("aria-label", "暂停");
  await page.locator("#seek").fill("8");
  await expect(page.locator("#elapsed")).toHaveText("0:08");
  await page.locator("#toggle").click();
  await page.locator("#toggle").click();
  await expectSameNodes(page, ".song-row, .song-row img");
  await page.locator('[data-view="discover"]').click();
  await page.locator(".brand").click();
  await expectSameNodes(page, ".song-row, .song-row img");
  expect(
    await page.evaluate(
      () =>
        (window as any).__motionCalls.filter(
          (call: any) => call.operation === "search_songs",
        ).length,
    ),
  ).toBe(1);
});

test("active playlist filters and unchanged refreshes retain loaded cards without a blank intermediate frame", async ({
  page,
}) => {
  await fixture(page);
  await page.locator('[data-view="playlists"]').click();
  await expect(page.locator(".playlist-card")).toHaveCount(3);
  await expectResting(page, "#playlist-grid");
  await rememberNodes(page, ".playlist-card, .playlist-card img");
  await page.locator('[data-playlist-filter="netease"]').click();
  await expectSameNodes(page, ".playlist-card, .playlist-card img");
  await page.evaluate(() => {
    const w = window as any;
    w.__motionHoldPlaylists = true;
    w.__motionFinishPlaylists = [];
  });
  await page.locator("#refresh-playlists").click();
  await expect(page.locator("#refresh-playlists")).toBeDisabled();
  await expect(page.locator(".playlist-card")).toHaveCount(3);
  await expectSameNodes(page, ".playlist-card, .playlist-card img");
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__motionFinishPlaylists.length),
    )
    .toBe(2);
  await page.evaluate(() => {
    const w = window as any;
    w.__motionHoldPlaylists = false;
    w.__motionFinishPlaylists.forEach((resolve: () => void) => resolve());
  });
  await expect(page.locator("#refresh-playlists")).toBeEnabled();
  await expectSameNodes(page, ".playlist-card, .playlist-card img");
  await expectResting(page, "#playlist-grid");
});

test("refreshing the current playlist after an edit preserves unaffected rows and their decoded covers", async ({
  page,
}) => {
  await fixture(page);
  await page.locator('[data-view="playlists"]').click();
  await page.locator('[data-playlist="netease:1"]').click();
  await expect(page.locator("#section-title")).toContainText("动画歌单 1");
  await expect(page.locator(".song-row")).toHaveCount(3);
  const stableRows =
    '.song-row:not([data-song="netease:3"]), .song-row:not([data-song="netease:3"]) img';
  await rememberNodes(page, stableRows);
  await page.locator('[data-song-menu="netease:3"]').click();
  await page.locator("#song-remove").click();
  await page.evaluate(() => {
    (window as any).__motionHoldTracks = true;
  });
  await page.locator("#confirm-remove").click();
  await expect
    .poll(() =>
      page.evaluate(() => typeof (window as any).__motionFinishTracks),
    )
    .toBe("function");
  // The server refresh is outstanding; already-loaded rows must remain painted.
  await expectSameNodes(page, stableRows);
  await expect(page.locator('[data-song="netease:1"]')).toBeVisible();
  await expect(page.locator('[data-song="netease:2"]')).toBeVisible();
  await page.evaluate(() => {
    (window as any).__motionHoldTracks = false;
    (window as any).__motionFinishTracks();
  });
  await expect(page.locator(".song-row")).toHaveCount(2);
  await expect(page.locator("#library-dialog")).toBeHidden();
  await expectSameNodes(page, stableRows);
  await expectResting(page, "#songs");
});

test("rapid navigation and late search results leave the final page visible and interactive", async ({
  page,
}) => {
  await fixture(page);
  await page.locator("#search").fill("延迟搜索");
  await page.locator("#search").press("Enter");
  await expect
    .poll(() =>
      page.evaluate(() => typeof (window as any).__motionFinishSearch),
    )
    .toBe("function");
  await page.evaluate(() => {
    for (const view of ["favorites", "local", "queue", "discover", "favorites"])
      document
        .querySelector<HTMLButtonElement>(`[data-view="${view}"]`)!
        .click();
    (window as any).__motionFinishSearch();
  });
  await expect(page.locator('[data-view="favorites"]')).toHaveClass(/active/);
  await expect(page.locator("#section-title")).toContainText("收藏");
  await expect(page.locator(".song-row")).toHaveCount(1);
  await expectResting(page, "#songs");
  await expectResting(page, ".main-scroll");
  await page.locator(".song-title").click();
  await expect(page.locator(".song-title")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.locator(".brand").click();
  await expect(page.locator(".song-row")).toHaveCount(3);
  await expectResting(page, "#songs");
});

test("track artwork retains the decoded cover until the latest image is ready and rejects stale loads", async ({
  page,
}) => {
  const { releaseCover } = await fixture(page, [2, 3]);
  await page.locator(".song-row").first().dblclick();
  const initial = page.locator(`#now-cover img[src="${coverUrl(1)}"]`);
  await expect(initial).toBeVisible();
  await expect
    .poll(() => initial.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBe(32);
  await expectResting(page, "#now-cover");
  await page.locator("#next").click();
  await expect(page.locator("#now-name")).toHaveText("动画歌曲 2");
  await expect(initial).toBeVisible();
  await expect(page.locator("#now-cover .fallback-cover")).toHaveCount(0);
  await page.locator("#next").click();
  await expect(page.locator("#now-name")).toHaveText("动画歌曲 3");
  await expect(initial).toBeVisible();
  await releaseCover(3);
  const latest = page.locator(`#now-cover img[src="${coverUrl(3)}"]`);
  await expect(latest).toBeVisible();
  await expect
    .poll(() => latest.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBe(32);
  await expectResting(page, "#now-cover");
  await releaseCover(2);
  await expect
    .poll(() =>
      page
        .locator('.song-row img[src="https://motion.test/cover-2.png"]')
        .evaluate((img: HTMLImageElement) => img.naturalWidth),
    )
    .toBe(32);
  // Allow the decoded stale image's load and transition completion callbacks to run.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(page.locator("#now-name")).toHaveText("动画歌曲 3");
  await expect(latest).toBeVisible();
  await expect(
    page.locator(`#now-cover img[src="${coverUrl(2)}"]`),
  ).toHaveCount(0);
  await expect(page.locator("#now-cover .fallback-cover")).toHaveCount(0);
});

for (const dialog of ["account", "theme"]) {
  test(`${dialog} dismissal followed immediately by reopen cannot be closed by a stale animation`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await fixture(page);
    await page.locator(`#${dialog}-button`).click();
    await expect(page.locator(`#${dialog}-dialog`)).toBeVisible();
    await page.evaluate((dialog) => {
      document.querySelector<HTMLButtonElement>(`#${dialog}-close`)!.click();
      document.querySelector<HTMLButtonElement>(`#${dialog}-button`)!.click();
    }, dialog);
    await expectResting(page, `#${dialog}-dialog`);
    await expect(page.locator(`#${dialog}-dialog`)).toHaveAttribute("open", "");
    await page.keyboard.press("Escape");
    await expect(page.locator(`#${dialog}-dialog`)).toBeHidden();
    await page.locator("#search").fill("可以继续输入");
    await expect(page.locator("#search")).toBeFocused();
    expect(errors).toEqual([]);
  });
}

for (const mobile of [false, true]) {
  test(`${mobile ? "mobile" : "desktop"} reduced motion leaves navigation, lyrics and dialogs immediately usable`, async ({
    browser,
  }) => {
    const context = await browser.newContext({
      reducedMotion: "reduce",
      viewport: mobile
        ? { width: 393, height: 852 }
        : { width: 640, height: 800 },
      ...(mobile
        ? {
            isMobile: true,
            hasTouch: true,
            userAgent:
              "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile",
          }
        : {}),
    });
    const page = await context.newPage();
    await fixture(page);
    await page.locator('[data-view="favorites"]').click();
    await expectResting(page, "#songs");
    await page.locator("#lyrics-toggle").click();
    await expectResting(page, "#lyrics-panel");
    await page.locator("#lyrics-close").click();
    await expect(page.locator("#lyrics-panel")).toBeHidden();
    await expect(page.locator("#app")).not.toHaveAttribute("inert", "");
    await page.locator("#theme-button").click();
    await expectResting(page, "#theme-dialog");
    await page.locator("#theme-close").click();
    await expect(page.locator("#theme-dialog")).toBeHidden();
    await page.locator(".brand").click();
    await page.locator("#search").fill("减少动态效果");
    await expect(page.locator("#search")).toBeFocused();
    await expectResting(page, ".main-scroll");
    await context.close();
  });
}

test("enabling reduced motion during a dialog close completes dismissal without trapping focus", async ({
  page,
}) => {
  await fixture(page);
  await page.locator("#theme-button").click();
  await expect(page.locator("#theme-dialog")).toBeVisible();
  await page
    .locator("#theme-close")
    .evaluate((button: HTMLButtonElement) => button.click());
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator("#theme-dialog")).toBeHidden();
  await page.locator("#account-button").click();
  await expectResting(page, "#account-dialog");
  await page.keyboard.press("Escape");
  await expect(page.locator("#account-dialog")).toBeHidden();
  await page.locator("#search").fill("动态效果已关闭");
  await expect(page.locator("#search")).toBeFocused();
});

test("mobile lyrics can reverse an unfinished close and restore the app after final dismissal", async ({
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
  await fixture(page);
  await page.locator("#lyrics-toggle").tap();
  await expect(page.locator("#lyrics-panel")).toBeVisible();
  await page.evaluate(() => {
    document.querySelector<HTMLButtonElement>("#lyrics-close")!.click();
    document.querySelector<HTMLButtonElement>("#lyrics-toggle")!.click();
  });
  await expectResting(page, "#lyrics-panel");
  await expect(page.locator("#lyrics-toggle")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(page.locator("#app")).toHaveAttribute("inert", "");
  await page.locator("#lyrics-close").tap();
  await expect(page.locator("#lyrics-panel")).toBeHidden();
  await expect(page.locator("#app")).not.toHaveAttribute("inert", "");
  await page.locator("#search").fill("歌词已收起");
  await expect(page.locator("#search")).toBeFocused();
  await context.close();
});

test("pending track lyrics keep the previous lines inert and a stale response cannot replace the latest lyrics", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await fixture(page);
  await page.evaluate(() => {
    const w = window as any;
    const original = w.__TAURI_INTERNALS__.invoke;
    w.__motionFinishLyrics = {};
    w.__motionDeliveredLyrics = [];
    w.__TAURI_INTERNALS__.invoke = async (command: string, args: any = {}) => {
      if (command !== "song_lyric") return original(command, args);
      if (args.id > 1)
        await new Promise<void>((resolve) => {
          w.__motionFinishLyrics[args.id] = resolve;
        });
      w.__motionDeliveredLyrics.push(args.id);
      return `[00:00.00]第${args.id}首的开场歌词\n[00:08.00]第${args.id}首可点击的歌词`;
    };
  });
  await page.locator(".song-row").first().dblclick();
  await page.locator("#lyrics-toggle").click();
  await expect(page.locator("#lyrics [data-line]")).toHaveText([
    "第1首的开场歌词",
    "第1首可点击的歌词",
  ]);
  await expectResting(page, "#lyrics");
  await rememberNodes(page, "#lyrics [data-line]");

  await page.locator("#next").click();
  await expect(page.locator("#lyrics-title")).toHaveText("动画歌曲 2");
  await expect
    .poll(() =>
      page.evaluate(() => typeof (window as any).__motionFinishLyrics[2]),
    )
    .toBe("function");
  await expectSameNodes(page, "#lyrics [data-line]");
  await expect(page.locator("#lyrics")).toHaveAttribute("inert", "");
  await expect(page.locator("#lyrics")).toHaveAttribute("aria-busy", "true");
  await expect(page.locator("#lyrics [data-line]").first()).toBeVisible();

  await page.locator("#next").click();
  await expect(page.locator("#lyrics-title")).toHaveText("动画歌曲 3");
  await expect
    .poll(() =>
      page.evaluate(() => typeof (window as any).__motionFinishLyrics[3]),
    )
    .toBe("function");
  await expectSameNodes(page, "#lyrics [data-line]");
  await page.evaluate(() => (window as any).__motionFinishLyrics[3]());
  await expect(page.locator("#lyrics [data-line]")).toHaveText([
    "第3首的开场歌词",
    "第3首可点击的歌词",
  ]);
  await expect(page.locator("#lyrics")).not.toHaveAttribute("inert", "");
  await expect(page.locator("#lyrics")).toHaveAttribute("aria-busy", "false");
  await expectResting(page, "#lyrics");
  await rememberNodes(page, "#lyrics [data-line]");

  await page.evaluate(() => (window as any).__motionFinishLyrics[2]());
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__motionDeliveredLyrics.includes(2)),
    )
    .toBe(true);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expectSameNodes(page, "#lyrics [data-line]");
  await expect(page.locator("#lyrics [data-line]")).toHaveText([
    "第3首的开场歌词",
    "第3首可点击的歌词",
  ]);
  await page.locator('#lyrics [data-line="1"]').click();
  await expect(page.locator("#elapsed")).toHaveText("0:08");
  await expect(page.locator('#lyrics [data-line="1"]')).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(page.locator("#now-name")).toHaveText("动画歌曲 3");
});

test("a failed replacement search keeps prior results visible without offering their old pagination", async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(() => {
    const w = window as any;
    const original = w.__TAURI_INTERNALS__.invoke;
    w.__motionSearchRequests = [];
    w.__TAURI_INTERNALS__.invoke = async (command: string, args: any = {}) => {
      if (command !== "search_songs") return original(command, args);
      w.__motionSearchRequests.push({ query: args.query, offset: args.offset });
      if (args.query === "失败的新搜索") throw new Error("网络暂不可用");
      const response = await original(command, args);
      return { ...response, total: 6 };
    };
  });
  await page.locator("#search").fill("上次成功的搜索");
  await page.locator("#search").press("Enter");
  await expect(page.locator("#more")).toBeVisible();
  await expect(page.locator(".song-row")).toHaveCount(3);
  await rememberNodes(page, ".song-row, .song-row img");
  await page.locator("#search").fill("失败的新搜索");
  await page.locator("#search").press("Enter");
  await expect(page.locator("#error")).toContainText("网络暂不可用");
  await expect(page.locator("#search-summary")).toContainText("保留上次结果");
  await expectSameNodes(page, ".song-row, .song-row img");
  await expect(page.locator(".song-row")).toHaveCount(3);
  await expect(page.locator("#more")).toBeHidden();
  expect(
    await page.evaluate(() => (window as any).__motionSearchRequests),
  ).toEqual([
    { query: "上次成功的搜索", offset: 0 },
    { query: "失败的新搜索", offset: 0 },
  ]);
});

test("an artwork URL that failed can load again for a later track with the same cover", async ({
  page,
}) => {
  const { recoverCover } = await fixture(page, [], [2]);
  await page.evaluate(() => {
    const w = window as any;
    const original = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = async (command: string, args: any = {}) => {
      const response = await original(command, args);
      if (command !== "search_songs") return response;
      return {
        ...response,
        songs: response.songs.map((song: any) =>
          song.id === 3
            ? { ...song, cover: "https://motion.test/cover-2.png" }
            : song,
        ),
      };
    };
  });
  await page.locator("#search").fill("相同专辑封面重试");
  await page.locator("#search").press("Enter");
  await expect(page.locator('[data-song="netease:3"] img')).toHaveAttribute(
    "src",
    coverUrl(2),
  );
  await page.locator(".song-row").first().dblclick();
  await expect(
    page.locator(`#now-cover img[src="${coverUrl(1)}"]`),
  ).toBeVisible();
  await expectResting(page, "#now-cover");
  await page.locator("#next").click();
  await expect(page.locator("#now-name")).toHaveText("动画歌曲 2");
  await expect(page.locator("#now-cover .fallback-cover")).toBeVisible();
  await expectResting(page, "#now-cover");
  recoverCover(2);
  await page.locator("#next").click();
  await expect(page.locator("#now-name")).toHaveText("动画歌曲 3");
  const recovered = page.locator(`#now-cover img[src="${coverUrl(2)}"]`);
  await expect(recovered).toBeVisible();
  await expect
    .poll(() => recovered.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBe(32);
  await expectResting(page, "#now-cover");
  await expect(page.locator("#now-cover .fallback-cover")).toHaveCount(0);
});

test("changing quality for the current song preserves lyric nodes and scroll while the new stream loads", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await fixture(page);
  await page.evaluate(() => {
    const w = window as any;
    const original = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = async (command: string, args: any = {}) => {
      if (command === "song_lyric")
        return Array.from(
          { length: 30 },
          (_, index) =>
            `[00:${String(index).padStart(2, "0")}.00]保持位置的歌词 ${index}`,
        ).join("\n");
      if (command === "song_url" && w.__motionHoldQuality)
        await new Promise<void>((resolve) => {
          w.__motionFinishQuality = resolve;
        });
      return original(command, args);
    };
  });
  await page.locator(".song-row").first().dblclick();
  await expect(page.locator("#toggle")).toHaveAttribute("aria-label", "暂停");
  await page.locator("#toggle").click();
  await page.locator("#lyrics-toggle").click();
  await expect(page.locator("#lyrics [data-line]")).toHaveCount(30);
  await expectResting(page, "#lyrics-panel");
  await page.locator("#seek").fill("20");
  await expect(page.locator('#lyrics [data-line="20"]')).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect
    .poll(() => page.locator("#lyrics").evaluate((box) => box.scrollTop))
    .toBeGreaterThan(300);
  const scrollBefore = await page
    .locator("#lyrics")
    .evaluate((box) => box.scrollTop);
  await rememberNodes(page, "#lyrics [data-line]");
  await page.evaluate(() => {
    (window as any).__motionHoldQuality = true;
  });
  await page.locator("#quality").selectOption("lossless");
  await expect
    .poll(() =>
      page.evaluate(() => typeof (window as any).__motionFinishQuality),
    )
    .toBe("function");
  await expectSameNodes(page, "#lyrics [data-line]");
  expect(await page.locator("#lyrics").evaluate((box) => box.scrollTop)).toBe(
    scrollBefore,
  );
  await expect(page.locator('#lyrics [data-line="20"]')).toHaveAttribute(
    "aria-current",
    "true",
  );
  await page.evaluate(() => {
    (window as any).__motionHoldQuality = false;
    (window as any).__motionFinishQuality();
  });
  await expect(page.locator("#seek")).toBeEnabled();
  await expect(page.locator("#elapsed")).toHaveText("0:20");
  await expectSameNodes(page, "#lyrics [data-line]");
  expect(await page.locator("#lyrics").evaluate((box) => box.scrollTop)).toBe(
    scrollBefore,
  );
  await expect(page.locator('#lyrics [data-line="20"]')).toHaveAttribute(
    "aria-current",
    "true",
  );
});
