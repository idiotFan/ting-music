import { test, expect } from "@playwright/test";
import { PNG } from "pngjs";
import jsQR from "jsqr";
const qrUrl =
  "http://music.163.com/login?codekey=qa-only-key&chainId=v1_0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF01234567_web_login_1789543000000";
async function setup(page: any, restoreDelay = 0, restored = false) {
  await page.exposeFunction("__resizeLyricsForTest", async (open: boolean) => {
    const size = page.viewportSize();
    await page.setViewportSize({
      width: size.width + (open ? 320 : -320),
      height: size.height,
    });
  });
  await page.addInitScript(
    ({ qrUrl, restoreDelay, restored }: any) => {
      const w = window as any;
      w.__calls = [];
      w.__status = 801;
      w.__loggedIn = restored;
      const profile = { userId: 123, nickname: "测试账号", avatar: "" };
      const songs = [1, 2, 3].map((id) => ({
        id,
        name: `我的歌曲 ${id}`,
        artist: "测试歌手",
        album: "测试专辑",
        cover: "",
        duration: 20000,
        fee: 0,
      }));
      const wav = new ArrayBuffer(44 + 22050 * 20 * 2),
        d = new DataView(wav);
      const str = (o: number, s: string) =>
        [...s].forEach((c, i) => d.setUint8(o + i, c.charCodeAt(0)));
      str(0, "RIFF");
      d.setUint32(4, wav.byteLength - 8, true);
      str(8, "WAVEfmt ");
      d.setUint32(16, 16, true);
      d.setUint16(20, 1, true);
      d.setUint16(22, 1, true);
      d.setUint32(24, 22050, true);
      d.setUint32(28, 44100, true);
      d.setUint16(32, 2, true);
      d.setUint16(34, 16, true);
      str(36, "data");
      d.setUint32(40, wav.byteLength - 44, true);
      const url = URL.createObjectURL(new Blob([wav], { type: "audio/wav" }));
      w.__TAURI_INTERNALS__ = {
        invoke: async (cmd: string, args: any) => {
          w.__calls.push({ cmd, args });
          if (cmd === "qq_request" && args.operation === "account_status")
            return null;
          if (cmd === "set_lyrics_panel") {
            await w.__resizeLyricsForTest(args.open);
            return;
          }
          if (cmd === "account_status") {
            if (restoreDelay)
              await new Promise((r) => setTimeout(r, restoreDelay));
            return w.__loggedIn ? profile : null;
          }
          if (cmd === "search_songs") return { songs, total: 3 };
          if (cmd === "login_qr_start")
            return { key: "qa-only-key", url: qrUrl };
          if (cmd === "login_qr_check") {
            if (w.__status === 803) w.__loggedIn = true;
            return {
              code: w.__status,
              profile: w.__loggedIn ? profile : null,
              warning: null,
            };
          }
          if (cmd === "login_qr_cancel") return null;
          if (cmd === "logout") {
            w.__loggedIn = false;
            return null;
          }
          if (cmd === "my_playlists")
            return {
              playlists: [
                {
                  id: 44,
                  name: "我的私人歌单",
                  cover: "",
                  trackCount: 3,
                  creator: "测试账号",
                  owned: true,
                },
                {
                  id: 45,
                  name: "收藏的歌单",
                  cover: "",
                  trackCount: 3,
                  creator: "其他用户",
                  owned: false,
                },
              ],
              more: false,
            };
          if (cmd === "playlist_tracks")
            return {
              songs: args.offset === 0 ? songs.slice(0, 2) : songs.slice(2),
              total: 3,
              nextOffset: args.offset === 0 ? 2 : 3,
              name: "我的私人歌单",
            };
          if (cmd === "song_url")
            return {
              url,
              trial: false,
              trialStart: 0,
              bitrate: 320000,
              level: args.level,
              requestedLevel: args.level,
              format: "wav",
            };
          if (cmd === "song_lyric") {
            if (w.__lyricDelay)
              await new Promise((r) => setTimeout(r, w.__lyricDelay));
            return "[00:00.00]测试歌词第一行\n[00:01.00]测试歌词第二行\n[00:03.00]测试歌词第三行";
          }
          throw new Error(`unexpected ${cmd}`);
        },
      };
      Object.defineProperty(window, "isTauri", { value: true });
    },
    { qrUrl, restoreDelay, restored },
  );
  await page.goto("/");
}
test("QR exact pixel decode, login states, personal playlists, full queue, quality seek, logout", async ({
  page,
}) => {
  await setup(page);
  await page.locator("#account-button").click();
  await expect(page.locator("#login-qr")).toBeVisible();
  const png = PNG.sync.read(await page.locator("#login-qr").screenshot());
  const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  expect(decoded?.data).toBe(qrUrl);
  const source = await page.locator("#login-qr").getAttribute("src");
  const original = PNG.sync.read(Buffer.from(source!.split(",")[1], "base64"));
  expect(png.width).toBe(original.width);
  expect(png.height).toBe(original.height);
  expect(png.data.equals(original.data)).toBe(true);
  await page.evaluate(() => {
    (window as any).__status = 802;
  });
  await expect(page.locator("#account-status")).toContainText(
    "网易云音乐 App中确认",
    {
      timeout: 5000,
    },
  );
  await page.evaluate(() => {
    (window as any).__status = 803;
  });
  await expect(page.locator("#account-dialog")).not.toBeVisible({
    timeout: 5000,
  });
  await expect(page.locator("#account-name")).toHaveText("测试账号");
  await expect(page.locator(".playlist-card")).toHaveCount(2);
  await page.getByRole("button", { name: /我的私人歌单/ }).click();
  await expect(page.locator(".song-row")).toHaveCount(2);
  await page.locator("#play-all").click();
  await expect(page.locator("#queue-count")).toHaveText("3");
  await expect(page.locator("#toggle")).toHaveAttribute("aria-label", "暂停");
  await page.locator("#seek").fill("5");
  await page.locator("#toggle").click();
  await page.locator("#quality").selectOption("lossless");
  await expect(page.locator("#track-tag")).toContainText("无损");
  await expect(page.locator("#toggle")).toHaveAttribute("aria-label", "播放");
  await expect(page.locator("#elapsed")).toHaveText("0:05");
  expect(
    await page.evaluate(
      () =>
        (window as any).__calls.filter((c: any) => c.cmd === "song_url").at(-1)
          .args.level,
    ),
  ).toBe("lossless");
  await page.locator("#account-button").click();
  await page.locator("#logout").click();
  await expect(page.locator("#account-name")).toHaveText("登录");
  await expect(page.locator(".playlist-card")).toHaveCount(0);
  await expect(page.locator("#queue-count")).toHaveText("0");
});
test("play/pause, volume, favorites and lyric updates preserve existing DOM nodes", async ({
  page,
}) => {
  await setup(page);
  await expect(page.locator(".song-row")).toHaveCount(3);
  await page.evaluate(() => {
    const w = window as any;
    w.__svg = document.querySelector("#search-form svg");
    w.__row = document.querySelector(".song-row");
  });
  await page.locator(".song-row").first().dblclick();
  await expect(page.locator("#toggle")).toHaveAttribute("aria-label", "暂停");
  await page.locator("#seek").fill("3.5");
  await page.locator("#toggle").click();
  await page.locator("#volume").fill("0.3");
  await page
    .getByRole("button", { name: "收藏 我的歌曲 1", exact: true })
    .click();
  expect(
    await page.evaluate(() => {
      const w = window as any;
      return (
        w.__svg === document.querySelector("#search-form svg") &&
        w.__row === document.querySelector(".song-row")
      );
    }),
  ).toBe(true);
  await page.locator("#lyrics-toggle").click();
  const heights = await page
    .locator("#lyrics p")
    .evaluateAll((nodes) => nodes.map((n) => n.getBoundingClientRect().height));
  expect(new Set(heights).size).toBe(1);
  await page.screenshot({ path: "work/v03-compact.png" });
});
test("expired QR and close cancel polling", async ({ page }) => {
  await setup(page);
  await page.locator("#account-button").click();
  await expect(page.locator("#login-qr")).toBeVisible();
  await page.evaluate(() => {
    (window as any).__status = 800;
  });
  await expect(page.locator("#account-status")).toContainText("已过期", {
    timeout: 5000,
  });
  await page.locator("#account-close").click();
  expect(
    await page.evaluate(() =>
      (window as any).__calls.some((c: any) => c.cmd === "login_qr_cancel"),
    ),
  ).toBe(true);
});

test("quality changes while lyrics are loading still resolve current song lyrics", async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(() => {
    (window as any).__lyricDelay = 700;
  });
  await page.locator(".song-row").first().dblclick();
  await expect(page.locator("#toggle")).toHaveAttribute("aria-label", "暂停");
  await page.locator("#quality").selectOption("lossless");
  await expect(page.locator("#lyrics")).toContainText("测试歌词第一行");
  await expect(page.locator("#lyrics")).not.toContainText("正在寻找歌词");
});

test("interrupted play promise preserves lyrics and does not report a playback failure", async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(() => {
    HTMLMediaElement.prototype.play = function () {
      return Promise.reject(
        new DOMException("Playback interrupted by pause", "AbortError"),
      );
    };
  });
  await page.locator(".song-row").first().dblclick();
  await expect(page.locator("#lyrics")).toContainText("测试歌词第一行");
  await expect(page.locator("#track-tag")).not.toHaveText("播放未成功");
  await expect(page.locator("#toast")).not.toContainText(
    "Playback interrupted",
  );
});

test("shuffle traverses the queue without repeats, follows history and advances on end", async ({
  page,
}) => {
  await setup(page);
  await page.locator(".song-row").first().dblclick();
  await expect(page.locator("#toggle")).toHaveAttribute("aria-label", "暂停");
  const first = await page.locator("#now-name").textContent();
  await page.locator("#repeat").click();
  await expect(page.locator("#mode-label")).toHaveText("随机播放");
  await page.locator("#next").click();
  await expect(page.locator("#now-name")).not.toHaveText(first!);
  const second = await page.locator("#now-name").textContent();
  await page.locator("#previous").click();
  await expect(page.locator("#now-name")).toHaveText(first!);
  await page.locator("#next").click();
  await expect(page.locator("#now-name")).toHaveText(second!);
  await expect(page.locator("#duration")).toHaveText("0:20");
  await page.locator("#seek").fill("19.8");
  await expect(page.locator("#now-name")).not.toHaveText(second!, {
    timeout: 5000,
  });
  const third = await page.locator("#now-name").textContent();
  expect(new Set([first, second, third]).size).toBe(3);
  await page.reload();
  await expect(page.locator("#mode-label")).toHaveText("随机播放");
  await page.locator("#repeat").click();
  await expect(page.locator("#mode-label")).toHaveText("单曲循环");
  await page.locator(".song-row").first().dblclick();
  await expect(page.locator("#duration")).toHaveText("0:20");
  await page.locator("#seek").fill("19.8");
  await expect(page.locator("#elapsed")).toHaveText("0:00", { timeout: 5000 });
  await expect(page.locator("#now-name")).toHaveText(first!);
  await expect(page.locator("#toggle")).toHaveAttribute("aria-label", "暂停");
});

test("smallest window has usable controls, list, lyrics and intact QR", async ({
  page,
}) => {
  await page.setViewportSize({ width: 400, height: 560 });
  await setup(page);
  await page.locator(".song-row").first().dblclick();
  await page.locator("#lyrics-toggle").click();
  await expect(page.locator("#lyrics")).toBeVisible();
  const layout = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth > innerWidth,
    listHeight: document.querySelector(".main-scroll")!.getBoundingClientRect()
      .height,
    controlsRight: document
      .querySelector(".transport-buttons")!
      .getBoundingClientRect().right,
  }));
  expect(layout.overflow).toBe(false);
  expect(layout.listHeight).toBeGreaterThan(95);
  expect(layout.controlsRight).toBeLessThanOrEqual(400);
  await page.screenshot({ path: "work/v03-small.png" });
  await page.locator("#account-button").click();
  await expect(page.locator("#login-qr")).toBeVisible();
  const png = PNG.sync.read(await page.locator("#login-qr").screenshot());
  const original = PNG.sync.read(
    Buffer.from(
      (await page.locator("#login-qr").getAttribute("src"))!.split(",")[1],
      "base64",
    ),
  );
  expect(
    jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data,
  ).toBe(qrUrl);
  expect(png.width).toBe(original.width);
  expect(png.height).toBe(original.height);
  expect(png.data.equals(original.data)).toBe(true);
});

test("clicking one playlist song fills beyond 1000 tracks across view changes and restores the full queue", async ({
  page,
}) => {
  await setup(page);
  await page.locator("#account-button").click();
  await page.evaluate(() => {
    (window as any).__status = 803;
  });
  await expect(page.locator(".playlist-card")).toHaveCount(2, {
    timeout: 5000,
  });
  await page.evaluate(() => {
    const w = window as any,
      original = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = async (cmd: string, args: any) => {
      if (cmd === "playlist_tracks") {
        await new Promise((r) => setTimeout(r, 40));
        const end = Math.min(args.offset + 100, 1205);
        return {
          songs: Array.from({ length: end - args.offset }, (_, i) => ({
            id: 10000 + args.offset + i,
            name: `歌单歌曲 ${args.offset + i + 1}`,
            artist: "测试",
            album: "测试",
            cover: "",
            duration: 20000,
            fee: 0,
          })),
          total: 1205,
          nextOffset: end,
        };
      }
      return original(cmd, args);
    };
  });
  await page.getByRole("button", { name: /我的私人歌单/ }).click();
  await expect(page.locator(".song-row")).toHaveCount(100);
  await page.locator(".song-row").first().dblclick();
  await expect(page.locator("#toggle")).toHaveAttribute("aria-label", "暂停");
  await page.locator("[data-view=favorites]").click();
  await expect(page.locator("#queue-count")).toHaveText("1205", {
    timeout: 15000,
  });
  await expect(page.locator("#now-name")).toHaveText("歌单歌曲 1");
  await page.reload();
  await expect(page.locator("#queue-count")).toHaveText("1205");
});

test("an older playlist pagination response cannot overwrite a newly selected queue", async ({
  page,
}) => {
  await setup(page);
  await page.locator("#account-button").click();
  await page.evaluate(() => {
    (window as any).__status = 803;
  });
  await expect(page.locator(".playlist-card")).toHaveCount(2, {
    timeout: 5000,
  });
  await page.evaluate(() => {
    const w = window as any,
      original = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = async (cmd: string, args: any) => {
      if (cmd === "playlist_tracks" && args.offset > 0) {
        await new Promise((r) => setTimeout(r, 600));
        w.__oldPageReturned = true;
        return {
          songs: [
            {
              id: 999,
              name: "旧歌单尾页",
              artist: "测试",
              album: "",
              cover: "",
              duration: 20000,
              fee: 0,
            },
          ],
          total: 3,
          nextOffset: 3,
        };
      }
      return original(cmd, args);
    };
  });
  await page.getByRole("button", { name: /我的私人歌单/ }).click();
  await page.locator(".song-row").first().dblclick();
  await page.locator("[data-view=discover]").click();
  await page.locator(".song-row").last().dblclick();
  await expect
    .poll(() => page.evaluate(() => (window as any).__oldPageReturned))
    .toBe(true);
  await expect(page.locator("#queue-count")).toHaveText("3");
  await page.locator("[data-view=queue]").click();
  await expect(page.locator("#songs")).not.toContainText("旧歌单尾页");
});

test("download shows actual source and quality, prevents duplicates, and preserves playback", async ({
  page,
}) => {
  await setup(page);
  await expect(page.locator("#download-current")).toBeDisabled();
  await page.evaluate(() => {
    const w = window as any,
      original = w.__TAURI_INTERNALS__.invoke;
    w.__downloads = 0;
    w.__TAURI_INTERNALS__.invoke = async (cmd: string, args: any) => {
      if (cmd === "download_song") {
        w.__downloads++;
        await new Promise((r) => setTimeout(r, 400));
        return {
          filename: "测试.flac",
          path: "/Downloads/Ting/测试.flac",
          source: "qq",
          level: "lossless",
          format: "flac",
          bitrate: 900000,
          sampleRate: 44100,
          bitDepth: 16,
          warnings: [],
        };
      }
      if (cmd === "open_download_folder") {
        w.__folderOpened = true;
        return;
      }
      return original(cmd, args);
    };
  });
  await page.locator(".song-row").first().dblclick();
  await expect(page.locator("#toggle")).toHaveAttribute("aria-label", "暂停");
  await page.locator("#download-current").click();
  await expect(page.locator("#download-current")).toBeDisabled();
  await expect(page.locator("#download-status")).toContainText(
    "QQ 补源 · 无损 · FLAC · 16bit / 44.1kHz",
  );
  await expect(page.locator("#toggle")).toHaveAttribute("aria-label", "暂停");
  expect(await page.evaluate(() => (window as any).__downloads)).toBe(1);
  await page.locator("#download-folder").click();
  expect(await page.evaluate(() => (window as any).__folderOpened)).toBe(true);
});

test("single click selects without interrupting playback; double click and Enter play", async ({
  page,
}) => {
  await setup(page);
  const rows = page.locator(".song-row");
  await expect(rows).toHaveCount(3);
  await rows.nth(0).locator(".song-title").click();
  await expect(rows.nth(0)).toHaveClass(/selected/);
  expect(
    await page.evaluate(
      () =>
        (window as any).__calls.filter((c: any) => c.cmd === "song_url").length,
    ),
  ).toBe(0);
  await rows.nth(0).locator(".song-title").dblclick();
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("");
  await expect(page.locator("#now-name")).toHaveText("我的歌曲 1");
  await expect(page.locator("#toggle")).toHaveAttribute("aria-label", "暂停");
  await rows.nth(1).click();
  await expect(rows.nth(1)).toHaveClass(/selected/);
  await expect(page.locator("#now-name")).toHaveText("我的歌曲 1");
  expect(
    await page.evaluate(
      () =>
        (window as any).__calls.filter((c: any) => c.cmd === "song_url").length,
    ),
  ).toBe(1);
  await rows.nth(1).dblclick();
  await expect(page.locator("#now-name")).toHaveText("我的歌曲 2");
  expect(
    await page.evaluate(
      () =>
        (window as any).__calls.filter((c: any) => c.cmd === "song_url").length,
    ),
  ).toBe(2);
  await rows.nth(2).locator(".song-title").press("Enter");
  await expect(page.locator("#now-name")).toHaveText("我的歌曲 3");
  await rows.nth(0).locator("[data-favorite]").dblclick();
  await expect(page.locator("#now-name")).toHaveText("我的歌曲 3");
  expect(
    await page.evaluate(
      () =>
        (window as any).__calls.filter((c: any) => c.cmd === "song_url").length,
    ),
  ).toBe(3);
});

test("creating a mixed playlist during background queue fill preserves playback and all pages", async ({
  page,
}) => {
  await setup(page);
  await page.locator("#account-button").click();
  await page.evaluate(() => {
    (window as any).__status = 803;
  });
  await expect(page.locator(".playlist-card")).toHaveCount(2, {
    timeout: 5000,
  });
  await page.evaluate(() => {
    const w = window as any,
      original = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = async (cmd: string, args: any) => {
      if (cmd === "playlist_tracks") {
        if (args.offset > 0) await new Promise((r) => setTimeout(r, 800));
        const end = Math.min(args.offset + 100, 505);
        return {
          songs: Array.from({ length: end - args.offset }, (_, i) => ({
            id: 10000 + args.offset + i,
            name: `后台歌曲 ${args.offset + i + 1}`,
            artist: "测试",
            album: "测试",
            cover: "",
            duration: 20000,
            fee: 0,
          })),
          total: 505,
          nextOffset: end,
        };
      }
      return original(cmd, args);
    };
  });
  await page.locator('[data-playlist="netease:44"]').click();
  await page.locator(".song-row").first().dblclick();
  await expect(page.locator("#toggle")).toHaveAttribute("aria-label", "暂停");
  await page.locator('[data-song-menu="netease:10000"]').click();
  await page.locator("#song-add").click();
  await page.locator("#create-and-add").click();
  await page.locator("#playlist-name").fill("不打断播放");
  await page.getByRole("button", { name: "创建并加入", exact: true }).click();
  await expect(page.locator("#queue-count")).toHaveText("505", {
    timeout: 10000,
  });
  await expect(page.locator("#toggle")).toHaveAttribute("aria-label", "暂停");
  await expect(page.locator("#now-name")).toHaveText("后台歌曲 1");
});

test("lyrics expand to the right without squeezing the player, follow smoothly, seek and collapse", async ({
  page,
}) => {
  await page.setViewportSize({ width: 400, height: 560 });
  await setup(page);
  await page.evaluate(() => {
    const w = window as any,
      original = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = async (cmd: string, args: any) =>
      cmd === "song_lyric"
        ? Array.from(
            { length: 10 },
            (_, i) =>
              `[00:${String(i * 2).padStart(2, "0")}.00]第 ${i + 1} 句：风慢慢吹过`,
          ).join("\n")
        : original(cmd, args);
  });
  await page.locator(".song-row").first().dblclick();
  await expect(page.locator("#lyrics [data-line]")).toHaveCount(10);
  await expect(page.locator("#toggle")).toHaveAttribute("aria-label", "暂停");
  await page.locator("#toggle").click();
  const before = await page.locator(".main-scroll").boundingBox();
  await page.locator("#lyrics-toggle").click();
  await expect(page.locator("#lyrics-panel")).toBeVisible();
  const after = await page.locator(".main-scroll").boundingBox();
  expect(after!.width).toBe(before!.width);
  expect(after!.height).toBe(before!.height);
  expect(page.viewportSize()!.width).toBe(720);
  expect((await page.locator("#lyrics-panel").boundingBox())!.x).toBe(400);
  await page.locator("#seek").fill("10.2");
  await expect(page.locator("#lyrics .current")).toHaveAttribute(
    "data-line",
    "5",
  );
  const centered = await page.evaluate(() => {
    const box = document.querySelector("#lyrics")!.getBoundingClientRect(),
      line = document
        .querySelector("#lyrics .current")!
        .getBoundingClientRect();
    return Math.abs(line.y + line.height / 2 - (box.y + box.height / 2));
  });
  expect(centered).toBeLessThan(3);
  await expect
    .poll(() =>
      page
        .locator("#lyrics .current")
        .evaluate((el) => Number(getComputedStyle(el).opacity)),
    )
    .toBe(1);
  await page.screenshot({ path: "work/lyrics-right-panel.png" });
  await page.locator("#lyrics").dispatchEvent("wheel", { deltaY: 100 });
  await expect(page.locator("#lyrics-follow")).toBeVisible();
  await page.locator("#lyrics-follow").click();
  await expect(page.locator("#lyrics-follow")).not.toBeVisible();
  await page.locator('#lyrics [data-line="4"]').click();
  await expect(page.locator("#lyrics .current")).toHaveAttribute(
    "data-line",
    "4",
  );
  await expect(page.locator("#elapsed")).toHaveText("0:08");
  await expect(page.locator("#toggle")).toHaveAttribute("aria-label", "播放");
  await page.locator("#lyrics-close").click();
  await expect(page.locator("#lyrics-panel")).not.toBeVisible();
  expect(page.viewportSize()!.width).toBe(400);
  expect((await page.locator(".main-scroll").boundingBox())!.height).toBe(
    before!.height,
  );
});

test("removed history entries do not reappear in queue", async ({ page }) => {
  await setup(page);
  await page.locator('[data-song="netease:1"]').dblclick();
  await page.locator('[data-view="queue"]').click();
  for (const id of [2, 3]) {
    await page.locator(`[data-song="netease:${id}"]`).dblclick();
    await expect(page.locator("#toggle")).toHaveAttribute("aria-label", "暂停");
  }
  await page.locator('[data-remove="netease:2"]').click();
  await page.locator("#previous").click();
  await expect(page.locator("#now-name")).toHaveText("我的歌曲 1");
  await expect(page.locator("#queue-count")).toHaveText("2");
  await page.locator("#next").click();
  await expect(page.locator("#now-name")).toHaveText("我的歌曲 3");
});

test("removing playing item preserves automatic successor", async ({
  page,
}) => {
  await setup(page);
  await page.locator('[data-song="netease:1"]').dblclick();
  await expect(page.locator("#toggle")).toHaveAttribute("aria-label", "暂停");
  await page.locator('[data-view="queue"]').click();
  await page.locator('[data-remove="netease:1"]').click();
  await page.locator("#seek").fill("19.9");
  await expect(page.locator("#now-name")).toHaveText("我的歌曲 2");
  await expect(page.locator("#queue-count")).toHaveText("2");
});

test("canceling account dialog during restoration preserves existing login", async ({
  page,
}) => {
  await setup(page, 1500, true);
  await page.locator("#account-button").click();
  await expect(page.locator(".account-subtitle")).toContainText("正在恢复");
  await page.locator("#account-close").click();
  await expect(page.locator("#account-name")).toHaveText("测试账号");
  expect(
    await page.evaluate(() =>
      (window as any).__calls.some(
        (c: any) => c.cmd === "login_qr_start" || c.cmd === "login_qr_cancel",
      ),
    ),
  ).toBe(false);
  await page.locator("#account-button").click();
  await expect(page.locator(".account-profile")).toContainText("测试账号");
});

test("selecting within a large queue only updates the changed rows", async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(() => {
    const songs = Array.from({ length: 5000 }, (_, i) => ({
      id: i + 1,
      name: `歌曲 ${i}`,
      artist: "歌手",
      album: "专辑",
      cover: "",
      duration: 20000,
      fee: 0,
    }));
    localStorage.setItem("ting.queue", JSON.stringify(songs));
    localStorage.setItem("ting.favorites", JSON.stringify(songs));
  });
  await page.reload();
  await page.locator('[data-view="queue"]').click();
  await expect(page.locator(".song-row")).toHaveCount(5000);
  const mutations = await page.evaluate(async () => {
    const box = document.querySelector("#songs")!;
    const changes: MutationRecord[] = [];
    const observer = new MutationObserver((records) =>
      changes.push(...records),
    );
    observer.observe(box, { subtree: true, attributes: true, childList: true });
    (box.querySelector('[data-song="netease:1"]') as HTMLElement).click();
    (box.querySelector('[data-song="netease:2"]') as HTMLElement).click();
    await Promise.resolve();
    observer.disconnect();
    return changes.length;
  });
  expect(mutations).toBeLessThan(12);
  await expect(page.locator(".song-row.selected")).toHaveAttribute(
    "data-song",
    "netease:2",
  );
});

test("quality reload does not reinsert removed playing item and repeat yields to its successor", async ({
  page,
}) => {
  await setup(page);
  await page.locator('[data-song="netease:1"]').dblclick();
  await expect(page.locator("#toggle")).toHaveAttribute("aria-label", "暂停");
  await page.locator("#repeat").click();
  await page.locator("#repeat").click();
  await expect(page.locator("#mode-label")).toHaveText("单曲循环");
  await page.locator('[data-view="queue"]').click();
  await page.locator('[data-remove="netease:1"]').click();
  await page.locator("#quality").selectOption("lossless");
  await expect(page.locator("#track-tag")).toContainText("无损");
  await expect(page.locator("#queue-count")).toHaveText("2");
  await expect(page.locator('[data-song="netease:1"]')).toHaveCount(0);
  await page.locator("#seek").fill("19.9");
  await expect(page.locator("#now-name")).toHaveText("我的歌曲 2");
});

test("malformed saved records do not prevent startup or discard valid songs", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "ting.playlists",
      JSON.stringify([
        null,
        {},
        { internal: true, id: 1, name: "损坏歌单", songs: [] },
      ]),
    );
    localStorage.setItem(
      "ting.playlist-recent",
      JSON.stringify([
        null,
        { account: "123", at: 1, playlist: { id: 1, name: "无元数据" } },
      ]),
    );
    localStorage.setItem(
      "ting.queue",
      JSON.stringify([
        null,
        {
          id: 8,
          name: "保留歌曲",
          artist: "歌手",
          album: "专辑",
          cover: "",
          duration: 20000,
          fee: 0,
        },
      ]),
    );
  });
  await setup(page);
  await page.locator('[data-view="queue"]').click();
  await expect(page.locator(".song-row")).toHaveCount(1);
  await expect(page.locator(".song-row")).toContainText("保留歌曲");
  await page.locator('[data-view="playlists"]').click();
  await page.locator('[data-playlist-filter="internal"]').click();
  await expect(page.locator(".playlist-card")).toHaveCount(0);
});

test("system media metadata follows real audio switching, pause and resume", async ({
  page,
}) => {
  await setup(page);
  await page.locator(".song-row").nth(0).dblclick();
  await expect
    .poll(() => page.evaluate(() => navigator.mediaSession.metadata?.title))
    .toBe("我的歌曲 1");
  await expect
    .poll(() => page.evaluate(() => navigator.mediaSession.playbackState))
    .toBe("playing");
  const artwork = await page.evaluate(
    () => navigator.mediaSession.metadata!.artwork[0],
  );
  expect(artwork.sizes).toBe("512x512");
  expect(artwork.type).toBe("image/png");
  const png = PNG.sync.read(Buffer.from(artwork.src.split(",")[1], "base64"));
  expect(png.width).toBe(512);
  await page.locator("#toggle").click();
  await expect
    .poll(() => page.evaluate(() => navigator.mediaSession.playbackState))
    .toBe("paused");
  await page.locator(".song-row").nth(1).dblclick();
  await expect
    .poll(() => page.evaluate(() => navigator.mediaSession.metadata?.title))
    .toBe("我的歌曲 2");
  await expect
    .poll(() => page.evaluate(() => navigator.mediaSession.playbackState))
    .toBe("playing");
});
