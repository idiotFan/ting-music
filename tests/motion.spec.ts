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
  const initial = page.locator(
    `#now-cover > img:not(.now-glow)[src="${coverUrl(1)}"]`,
  );
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
  const latest = page.locator(
    `#now-cover > img:not(.now-glow)[src="${coverUrl(3)}"]`,
  );
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
    page.locator(`#now-cover > img:not(.now-glow)[src="${coverUrl(2)}"]`),
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
    page.locator(`#now-cover > img:not(.now-glow)[src="${coverUrl(1)}"]`),
  ).toBeVisible();
  await expectResting(page, "#now-cover");
  await page.locator("#next").click();
  await expect(page.locator("#now-name")).toHaveText("动画歌曲 2");
  await expect(page.locator("#now-cover .fallback-cover")).toBeVisible();
  await expectResting(page, "#now-cover");
  recoverCover(2);
  await page.locator("#next").click();
  await expect(page.locator("#now-name")).toHaveText("动画歌曲 3");
  const recovered = page.locator(
    `#now-cover > img:not(.now-glow)[src="${coverUrl(2)}"]`,
  );
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

// The first keyframe of the library's entrance is the whole spatial claim:
// which side the page comes from, how far, how long and how hidden it starts.
async function libraryEntrance(page: Page, click: () => Promise<void>) {
  const before = await page.evaluate(
    () => document.querySelector(".library")!.getAnimations().length,
  );
  await click();
  return page.evaluate((before) => {
    const library = document.querySelector(".library")!;
    const animation = library
      .getAnimations()
      .find((candidate) => candidate.effect instanceof KeyframeEffect);
    const effect = animation?.effect as KeyframeEffect | undefined;
    const frames = effect?.getKeyframes() ?? [];
    const start = String(frames[0]?.transform ?? "");
    return {
      started: library.getAnimations().length > 0 || before > 0,
      offset: Number(/(-?[\d.]+)px/.exec(start)?.[1] ?? NaN),
      opacity: String(frames[0]?.opacity ?? ""),
      duration: Number(effect?.getTiming().duration ?? NaN),
    };
  }, before);
}

test("视图切换按导航顺序讲方向，层级推入与退出的幅度和时长不同", async ({
  page,
}) => {
  await fixture(page);
  const forward = await libraryEntrance(page, () =>
    page.locator('[data-view="queue"]').click(),
  );
  // Later tab: the page arrives from the right, fully hidden until it lands.
  expect(forward).toMatchObject({ offset: 16, opacity: "0", duration: 240 });
  await expectResting(page, ".library");

  const backward = await libraryEntrance(page, () =>
    page.locator('[data-view="discover"]').click(),
  );
  expect(backward).toMatchObject({ offset: -16, duration: 240 });
  await expectResting(page, ".library");

  await page.locator('[data-view="playlists"]').click();
  await expect(page.locator(".playlist-card")).toHaveCount(3);
  await expectResting(page, ".library");
  const push = await libraryEntrance(page, () =>
    page.locator('[data-playlist="netease:1"]').click(),
  );
  // One layer deeper: same direction as a forward tab, but heavier and slower.
  expect(push).toMatchObject({ offset: 28, duration: 300 });
  await expect(page.locator("#back-button")).toBeVisible();
  // The back entrance trails the content, so it reads as a consequence.
  expect(
    await page.locator("#back-button").evaluate((element) => {
      const effect = element.getAnimations()[0]?.effect as
        KeyframeEffect | undefined;
      const timing = effect?.getTiming();
      return {
        delay: timing?.delay ?? null,
        duration: timing?.duration ?? null,
      };
    }),
  ).toEqual({ delay: 80, duration: 240 });
  await expectResting(page, ".library");

  const pop = await libraryEntrance(page, () =>
    page.locator("#back-button").click(),
  );
  expect(pop).toMatchObject({ offset: -28, duration: 240 });
  await expect(page.locator("#section-title")).toContainText("我的歌单");
  await expectResting(page, ".library");
});

test("横向视图切换不产生水平溢出", async ({ page }) => {
  await fixture(page);
  const overflow = () =>
    page
      .locator(".main-scroll")
      .evaluate((element) => element.scrollWidth - element.clientWidth);
  for (const view of ["playlists", "favorites", "local", "queue", "discover"]) {
    // Sampled while the entrance is still travelling, not only once at rest.
    expect(
      await page.evaluate((view) => {
        document
          .querySelector<HTMLButtonElement>(`[data-view="${view}"]`)!
          .click();
        const element = document.querySelector<HTMLElement>(".main-scroll")!;
        return element.scrollWidth - element.clientWidth;
      }, view),
    ).toBeLessThanOrEqual(1);
    await page.waitForTimeout(100);
    expect(await overflow()).toBeLessThanOrEqual(1);
    await expectResting(page, ".main-scroll");
    expect(await overflow()).toBeLessThanOrEqual(1);
  }
});

test("快速反复切换视图后库停在正确终态", async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => {
    for (const view of [
      "queue",
      "discover",
      "queue",
      "local",
      "discover",
      "favorites",
    ])
      document
        .querySelector<HTMLButtonElement>(`[data-view="${view}"]`)!
        .click();
  });
  await expectResting(page, ".library");
  expect(
    await page.locator(".library").evaluate((element) => ({
      transform: getComputedStyle(element).transform,
      opacity: getComputedStyle(element).opacity,
      inline: element.getAttribute("style") || "",
    })),
  ).toEqual({ transform: "none", opacity: "1", inline: "" });
  await expect(page.locator('[data-view="favorites"]')).toHaveClass(/active/);
  await expect(page.locator(".song-row")).toHaveCount(1);
  await page.locator(".song-title").click();
  await expect(page.locator(".song-title")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("加载更多只让新增的行入场，已读的行一帧不动", async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => {
    const w = window as any;
    const original = w.__TAURI_INTERNALS__.invoke;
    w.__motionReleaseMore = undefined;
    w.__TAURI_INTERNALS__.invoke = async (command: string, args: any = {}) => {
      if (command !== "search_songs") return original(command, args);
      const offset = args.offset || 0;
      if (offset)
        await new Promise<void>((resolve) => {
          w.__motionReleaseMore = resolve;
        });
      return {
        songs: Array.from({ length: 20 }, (_, index) => ({
          id: offset + index + 1,
          name: `分页歌曲 ${offset + index + 1}`,
          artist: "分页歌手",
          album: "分页专辑",
          cover: "",
          duration: 20000,
          fee: 0,
        })),
        total: 40,
      };
    };
  });
  await page.locator("#search").fill("分页搜索");
  await page.locator("#search").press("Enter");
  await expect(page.locator(".song-row")).toHaveCount(20);
  await expectResting(page, "#songs");
  // Read to the bottom first: rows that arrive far below the fold must not
  // animate at all, and the ones that do are the ones being looked at.
  await page
    .locator(".main-scroll")
    .evaluate((element) => (element.scrollTop = element.scrollHeight));
  await page.locator("#more").click();
  await expect
    .poll(() => page.evaluate(() => typeof (window as any).__motionReleaseMore))
    .toBe("function");
  const rows = await page.evaluate(async () => {
    const before = new Set(
      [...document.querySelectorAll<HTMLElement>(".song-row")].map(
        (row) => row.dataset.song!,
      ),
    );
    (window as any).__motionReleaseMore();
    while (document.querySelectorAll(".song-row").length !== 40)
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
    return [...document.querySelectorAll<HTMLElement>(".song-row")].map(
      (row) => ({
        existed: before.has(row.dataset.song!),
        animations: row.getAnimations().length,
      }),
    );
  });
  expect(rows).toHaveLength(40);
  expect(
    rows.filter((row) => row.existed).every((row) => !row.animations),
  ).toBe(true);
  const animated = rows.filter((row) => row.animations > 0);
  expect(animated.length).toBeGreaterThan(0);
  expect(animated.length).toBeLessThanOrEqual(8);
  await expectResting(page, "#songs");
});

test("切换视图时列表行不再各自入场", async ({ page }) => {
  await fixture(page);
  // The first render staggers its rows in; wait for that before measuring.
  await expectResting(page, "#songs");
  const animations = await page.evaluate(() => {
    document
      .querySelector<HTMLButtonElement>('[data-view="favorites"]')!
      .click();
    return {
      rows: [...document.querySelectorAll(".song-row")].reduce(
        (total, row) => total + row.getAnimations().length,
        0,
      ),
      library: document.querySelector(".library")!.getAnimations().length,
    };
  });
  // The library carries the whole transition; the rows inside it stay put.
  expect(animations).toEqual({ rows: 0, library: 1 });
  await expect(page.locator(".song-row")).toHaveCount(1);
  await expectResting(page, "#songs");
});

test("减少动态效果时方向感退化为即时到位且功能不变", async ({ browser }) => {
  const context = await browser.newContext({
    reducedMotion: "reduce",
    viewport: { width: 480, height: 720 },
  });
  const page = await context.newPage();
  await fixture(page);
  expect(
    await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>('[data-view="queue"]')!.click();
      return document.querySelector(".library")!.getAnimations().length;
    }),
  ).toBe(0);
  await page.locator('[data-view="playlists"]').click();
  await expect(page.locator(".playlist-card")).toHaveCount(3);
  expect(
    await page.evaluate(() =>
      [...document.querySelectorAll(".playlist-card")].reduce(
        (total, card) => total + card.getAnimations().length,
        0,
      ),
    ),
  ).toBe(0);
  await page.locator('[data-playlist="netease:1"]').click();
  await expect(page.locator("#section-title")).toContainText("动画歌单 1");
  await expect(page.locator("#back-button")).toBeVisible();
  expect(
    await page
      .locator("#back-button")
      .evaluate((el) => el.getAnimations().length),
  ).toBe(0);
  await expect(page.locator(".library")).toHaveCSS("opacity", "1");
  await page.locator("#back-button").click();
  await expect(page.locator("#section-title")).toContainText("我的歌单");
  await expect(page.locator("#back-button")).toBeHidden();
  await context.close();
});

test("切换视图途中开启减少动态效果会立即就位", async ({ page }) => {
  await fixture(page);
  await page.evaluate(() =>
    document.querySelector<HTMLButtonElement>('[data-view="queue"]')!.click(),
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expectResting(page, ".library");
  expect(
    await page
      .locator(".library")
      .evaluate((element) => getComputedStyle(element).transform),
  ).toBe("none");
  await expect(page.locator('[data-view="queue"]')).toHaveClass(/active/);
  await page.locator('[data-view="favorites"]').click();
  await expect(page.locator(".song-row")).toHaveCount(1);
  await expectResting(page, ".library");
});

// Playback feedback is driven by the media element itself, so the tests watch
// body[data-playback] rather than the transport button, which stays optimistic.
const playbackState = (page: Page) => page.locator("body");

test("播放状态以真实音频事件为准，播放按钮保持意图态", async ({ page }) => {
  await fixture(page);
  await page.route("https://motion.test/broken.wav", (route) =>
    route.abort("failed"),
  );
  await page.evaluate(() => {
    const w = window as any;
    const original = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = async (command: string, args: any = {}) => {
      if (command !== "song_url") return original(command, args);
      if (w.__holdUrl)
        await new Promise<void>((resolve) => {
          w.__finishUrl = resolve;
        });
      const response = await original(command, args);
      return w.__breakUrl
        ? { ...response, url: "https://motion.test/broken.wav" }
        : response;
    };
    w.__holdUrl = true;
  });
  await page.locator(".song-row").first().dblclick();
  // Intent flips at once; the cover keeps waiting for a real `playing` event.
  await expect(page.locator("#toggle")).toHaveAttribute("aria-label", "暂停");
  await expect(playbackState(page)).toHaveAttribute("data-playback", "loading");
  await page.evaluate(() => {
    const w = window as any;
    w.__holdUrl = false;
    w.__finishUrl();
  });
  await expect(playbackState(page)).toHaveAttribute("data-playback", "playing");

  await page.locator("#toggle").click();
  await expect(playbackState(page)).toHaveAttribute("data-playback", "paused");
  await expect(page.locator("#toggle")).toHaveAttribute("aria-label", "播放");

  await page.evaluate(() => {
    (window as any).__breakUrl = true;
  });
  await page.locator("#next").click();
  await expect(playbackState(page)).toHaveAttribute("data-playback", "error");
  await expect(page.locator("#track-tag")).toHaveText(/失败|未成功/);
  // A failure is a still red equalizer, never a beat that suggests progress.
  expect(
    await page
      .locator(".now-heading .now-eq i")
      .evaluateAll((items) =>
        items.map((item) => getComputedStyle(item).animationName),
      ),
  ).toEqual(["none", "none", "none"]);
});

test("均衡器只在真实播放时跳动，暂停即放平", async ({ page }) => {
  await fixture(page);
  const eq = page.locator(".now-heading .now-eq");
  const bars = () =>
    eq.locator("i").evaluateAll((items) =>
      items.map((item) => ({
        animation: getComputedStyle(item).animationName,
        running: item
          .getAnimations()
          .some((animation) => animation.playState === "running"),
      })),
    );
  // Idle: no track, no equalizer column at all.
  await expect(eq).toBeHidden();

  await page.locator(".song-row").first().dblclick();
  await expect(playbackState(page)).toHaveAttribute("data-playback", "playing");
  await expect(eq).toBeVisible();
  const playing = await bars();
  expect(playing).toHaveLength(3);
  expect(playing.every((bar) => bar.animation === "now-eq")).toBe(true);
  expect(playing.every((bar) => bar.running)).toBe(true);
  // The equalizer sits beside the title, never on top of the artwork.
  const cover = (await page.locator("#now-cover").boundingBox())!;
  const badge = (await eq.boundingBox())!;
  expect(badge.x).toBeGreaterThanOrEqual(cover.x + cover.width);
  // Replacing the artwork must not disturb it.
  await page.locator("#next").click();
  await expect(page.locator("#now-name")).toHaveText("动画歌曲 2");
  await expect(playbackState(page)).toHaveAttribute("data-playback", "playing");
  await expect(eq.locator("i")).toHaveCount(3);

  await page.locator("#toggle").click();
  await expect(playbackState(page)).toHaveAttribute("data-playback", "paused");
  expect((await bars()).every((bar) => bar.animation === "none")).toBe(true);
  await expect(eq).toBeVisible();
});

test("播放时封面后方的光晕呼吸，暂停即淡出，封面本身从不缩放", async ({
  page,
}) => {
  await fixture(page);
  const glow = () =>
    page.locator("#now-cover").evaluate((element) => {
      const glow = element.querySelector(".now-glow") as HTMLElement;
      const style = getComputedStyle(glow);
      return {
        animation: style.animationName,
        opacity: Number(style.opacity),
        // The glow shows the same artwork as the cover.
        src: (glow as HTMLImageElement).getAttribute("src") || "",
        transform: getComputedStyle(element).transform,
        // Nothing may animate the cover box itself.
        own: element.getAnimations().length,
      };
    });
  expect((await glow()).opacity).toBe(0);
  await page.locator(".song-row").first().dblclick();
  await expect(playbackState(page)).toHaveAttribute("data-playback", "playing");
  const playing = await glow();
  expect(playing.animation).toBe("now-glow");
  expect(playing.src).toContain("cover-1.png");
  expect(playing.transform).toBe("none");
  expect(playing.own).toBe(0);
  await page.locator("#toggle").click();
  await expect(playbackState(page)).toHaveAttribute("data-playback", "paused");
  await expect
    .poll(async () => (await glow()).opacity, { timeout: 2000 })
    .toBe(0);
  expect((await glow()).animation).toBe("none");
  expect((await glow()).transform).toBe("none");
});

test("减少动态效果时播放状态仍然一眼可辨", async ({ browser }) => {
  const context = await browser.newContext({
    reducedMotion: "reduce",
    viewport: { width: 480, height: 720 },
  });
  const page = await context.newPage();
  await fixture(page);
  await page.locator(".song-row").first().dblclick();
  await expect(playbackState(page)).toHaveAttribute("data-playback", "playing");
  expect(
    await page
      .locator(".now-card")
      .evaluate((element) => element.getAnimations({ subtree: true }).length),
  ).toBe(0);
  const read = () =>
    page.locator("#now-cover").evaluate((element) => {
      const bars = Array.from(
        document.querySelectorAll(".now-heading .now-eq i"),
      ).map((bar) => {
        const style = getComputedStyle(bar);
        return { transform: style.transform, color: style.backgroundColor };
      });
      const glow = getComputedStyle(element.querySelector(".now-glow")!);
      return {
        glow: Number(glow.opacity),
        animation: glow.animationName,
        bars,
      };
    });
  const playing = await read();
  expect(playing.animation).toBe("none");
  expect(playing.glow).toBeGreaterThan(0);
  // A stepped silhouette still reads as "playing" without motion.
  expect(new Set(playing.bars.map((bar) => bar.transform)).size).toBe(3);
  await page.locator("#toggle").click();
  await expect(playbackState(page)).toHaveAttribute("data-playback", "paused");
  const paused = await read();
  expect(paused.glow).toBe(0);
  expect(paused.bars[0].color).not.toBe(playing.bars[0].color);
  await expect(page.locator("#now-cover")).toHaveCSS("transform", "none");
  await context.close();
});

test("当前播放行在窄窗口和宽窗口都带播放状态点", async ({ page }) => {
  await fixture(page);
  await page.locator(".song-row").first().dblclick();
  await expect(playbackState(page)).toHaveAttribute("data-playback", "playing");
  for (const width of [1280, 393]) {
    await page.setViewportSize({ width, height: 800 });
    expect(
      await page
        .locator(".song-row.playing .song-info small")
        .first()
        .evaluate((element) => {
          const style = getComputedStyle(element, "::before");
          return {
            width: style.width,
            height: style.height,
            animation: style.animationName,
          };
        }),
    ).toEqual({ width: "5px", height: "5px", animation: "now-wait" });
  }
  // One row carries the marker, so the whole table animates a single element.
  expect(
    await page.evaluate(
      () =>
        document.querySelectorAll(".song-row.playing .song-info small").length,
    ),
  ).toBe(1);
});

test("切歌带方向：下一首从右侧来，上一首从左侧来", async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => {
    const w = window as any;
    w.__coverEntrances = [];
    const original = Element.prototype.animate;
    Element.prototype.animate = function (frames: any, options?: any) {
      // Only the incoming artwork layer; the container carries the breath.
      if ((this as Element).parentElement?.id === "now-cover")
        w.__coverEntrances.push(String(frames?.[0]?.transform ?? ""));
      return original.call(this as any, frames, options);
    };
  });
  await page.locator(".song-row").first().dblclick();
  await expect(page.locator("#now-name")).toHaveText("动画歌曲 1");
  await expectResting(page, ".now-heading");

  const forward = await page.evaluate(() => {
    document.querySelector<HTMLButtonElement>("#next")!.click();
    const effect = document
      .querySelector(".now-heading")!
      .getAnimations()
      .find((animation) => animation.effect instanceof KeyframeEffect)
      ?.effect as KeyframeEffect | undefined;
    return String(effect?.getKeyframes()[0]?.transform ?? "");
  });
  expect(forward).toContain("translate3d(8px");
  await expect(page.locator("#now-name")).toHaveText("动画歌曲 2");
  await expectResting(page, ".now-heading");

  const backward = await page.evaluate(() => {
    document.querySelector<HTMLButtonElement>("#previous")!.click();
    const effect = document
      .querySelector(".now-heading")!
      .getAnimations()
      .find((animation) => animation.effect instanceof KeyframeEffect)
      ?.effect as KeyframeEffect | undefined;
    return String(effect?.getKeyframes()[0]?.transform ?? "");
  });
  expect(backward).toContain("translate3d(-8px");
  await expect(page.locator("#now-name")).toHaveText("动画歌曲 1");
  await expectResting(page, ".now-heading");

  // The artwork tells the same story, clipped by its own frame.
  await expect
    .poll(() => page.evaluate(() => (window as any).__coverEntrances))
    .toEqual(
      expect.arrayContaining([
        "translate3d(6%, 0, 0)",
        "translate3d(-6%, 0, 0)",
      ]),
    );
  await expectResting(page, "#now-cover");
});

test("歌词面板沿横轴进出，快速反复开关后不留残影", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await fixture(page);
  await page.evaluate(() => {
    const w = window as any;
    w.__panelFrames = [];
    const original = Element.prototype.animate;
    Element.prototype.animate = function (frames: any, options?: any) {
      if ((this as Element).id === "lyrics-panel")
        w.__panelFrames.push([
          String(frames?.[0]?.transform ?? ""),
          String(frames?.[1]?.transform ?? ""),
        ]);
      return original.call(this as any, frames, options);
    };
  });
  await page.locator("#lyrics-toggle").click();
  await expect(page.locator("#lyrics-panel")).toBeVisible();
  // A pane in normal flow travels a bounded distance, and arrives from the
  // same edge it is anchored to.
  await expect
    .poll(() => page.evaluate(() => (window as any).__panelFrames[0]))
    .toEqual(["translate3d(28px, 0, 0)", "none"]);
  await expectResting(page, "#lyrics-panel");

  await page.evaluate(() => {
    document.querySelector<HTMLButtonElement>("#lyrics-close")!.click();
    document.querySelector<HTMLButtonElement>("#lyrics-toggle")!.click();
  });
  await expectResting(page, "#lyrics-panel");
  await expect(page.locator("#lyrics-panel")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - innerWidth,
    ),
  ).toBeLessThanOrEqual(0);

  await page.locator("#lyrics-close").click();
  await expect(page.locator("#lyrics-panel")).toBeHidden();
  expect(
    await page
      .locator("#lyrics-panel")
      .evaluate((element) => element.getAttribute("style") || ""),
  ).toBe("");
});

test("弹窗按所处平台选择进出方向与时长", async ({ browser }) => {
  const read = (page: Page, selector: string, trigger: string) =>
    page.evaluate(
      ({ selector, trigger }) => {
        document.querySelector<HTMLButtonElement>(trigger)!.click();
        const effect = document
          .querySelector(selector)!
          .getAnimations()
          .find((animation) => animation.effect instanceof KeyframeEffect)
          ?.effect as KeyframeEffect | undefined;
        const frames = effect?.getKeyframes() ?? [];
        return {
          first: String(frames[0]?.transform ?? ""),
          last: String(frames[frames.length - 1]?.transform ?? ""),
          duration: Number(effect?.getTiming().duration ?? NaN),
        };
      },
      { selector, trigger },
    );

  const phone = await browser.newContext({
    viewport: { width: 393, height: 852 },
    isMobile: true,
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile",
  });
  const mobile = await phone.newPage();
  await fixture(mobile);
  // A sheet anchored to the bottom edge clears its own height, never a nudge,
  // and it must not overshoot past zero and reveal the page beneath it.
  const opening = await read(mobile, "#theme-dialog", "#theme-button");
  expect(opening.first).toContain("100%");
  expect(opening.last).toBe("none");
  expect(opening.duration).toBe(300);
  await expectResting(mobile, "#theme-dialog");
  const closing = await read(mobile, "#theme-dialog", "#theme-close");
  expect(closing.last).toContain("100%");
  expect(closing.duration).toBe(180);
  await expect(mobile.locator("#theme-dialog")).toBeHidden();
  await phone.close();

  const desktop = await browser.newContext({
    viewport: { width: 900, height: 700 },
  });
  const page = await desktop.newPage();
  await fixture(page);
  // On a desktop surface the dialog floats up: scale leads, offset supports.
  const floated = await read(page, "#theme-dialog", "#theme-button");
  expect(floated.first).toContain("scale(0.965)");
  expect(floated.first).toContain("10px");
  expect(floated.duration).toBe(300);
  await expectResting(page, "#theme-dialog");
  await desktop.close();
});

test("改变窗口宽度跨越两栏阈值时封面不缩放、均衡器留在标题旁", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await fixture(page);
  await page.locator(".song-row").first().dblclick();
  await expect(playbackState(page)).toHaveAttribute("data-playback", "playing");
  const read = () =>
    page.evaluate(() => {
      const cover = document.querySelector("#now-cover") as HTMLElement;
      const eq = document.querySelector(".now-heading .now-eq") as HTMLElement;
      const c = cover.getBoundingClientRect();
      const e = eq.getBoundingClientRect();
      return {
        width: Math.round(c.width),
        square: Math.abs(c.width - c.height) <= 1,
        transform: getComputedStyle(cover).transform,
        glow: getComputedStyle(cover.querySelector(".now-glow")!).animationName,
        // Beside the title in a row, below the artwork in a column; never on it.
        beside: e.left >= c.right || e.top >= c.bottom,
        overflow: document.documentElement.scrollWidth - innerWidth,
      };
    });
  for (const width of [760, 1280, 850, 1200]) {
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(80);
    const state = await read();
    expect(state.transform).toBe("none");
    expect(state.square).toBe(true);
    expect(state.glow).toBe("now-glow");
    expect(state.beside).toBe(true);
    expect(state.overflow).toBeLessThanOrEqual(0);
  }
  expect((await read()).width).toBeGreaterThan(300);
});
