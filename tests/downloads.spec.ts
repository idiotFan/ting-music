import { test, expect, type Page } from "@playwright/test";

function silence(seconds = 6) {
  const rate = 8000;
  const wav = Buffer.alloc(44 + rate * seconds * 2);
  wav.write("RIFF");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(wav.length - 44, 40);
  return wav;
}

type Options = { mobile?: boolean; scan?: any[]; failFirst?: boolean };
/** Desktop (or phone) Tauri with a download backend and a local shelf. */
async function setup(page: Page, options: Options = {}) {
  await page.route("**/__file/**", (route) =>
    route.fulfill({ status: 200, contentType: "audio/wav", body: silence() }),
  );
  if (options.mobile)
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "userAgent", {
        value:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
      });
    });
  await page.addInitScript((opts) => {
    const w = window as any;
    Object.defineProperty(window, "isTauri", { value: true });
    w.__calls = [];
    w.__active = 0;
    w.__peak = 0;
    w.__scan = opts.scan || [];
    w.__failed = new Set();
    const song = (id: number, name: string) => ({
      id,
      name,
      artist: "测试歌手",
      artists: [{ id: 7, name: "测试歌手" }],
      album: "测试专辑",
      albumId: 70,
      cover: "",
      duration: 6000,
      fee: 0,
    });
    w.__TAURI_INTERNALS__ = {
      convertFileSrc: (path: string) => "/__file/" + encodeURIComponent(path),
      invoke: async (cmd: string, args: any = {}, options: any = {}) => {
        w.__calls.push({ cmd, args });
        if (cmd === "search_songs")
          return {
            songs: [song(1, "第一首"), song(2, "第二首"), song(3, "第三首")],
            total: 3,
          };
        if (cmd === "account_status") return null;
        if (cmd === "catalog_search")
          return { artists: [], albums: [], playlists: [], total: 0 };
        if (cmd === "album_detail")
          return {
            album: {
              source: "netease",
              id: 70,
              name: "测试专辑",
              artist: "测试歌手",
              artistId: 7,
              cover: "",
              publishTime: 0,
              trackCount: 4,
            },
            description: "",
            songs: [
              song(1, "第一首"),
              song(2, "第二首"),
              song(3, "第三首"),
              song(4, "第四首"),
            ],
          };
        if (cmd === "download_song") {
          w.__active++;
          w.__peak = Math.max(w.__peak, w.__active);
          await new Promise((r) => setTimeout(r, 250));
          w.__active--;
          if (opts.failFirst && args.id === 3 && !w.__failed.has(3)) {
            w.__failed.add(3);
            throw "音源暂不可用";
          }
          const path = `/Downloads/Ting/歌曲${args.id}.flac`;
          w.__scan.push({
            id: -1000 - args.id,
            path,
            name: `歌曲${args.id}`,
            artist: "测试歌手",
            album: "测试专辑",
            duration: 6000,
            cover: "",
            origin: { source: "netease", id: args.id },
            gain: null,
          });
          return {
            filename: `歌曲${args.id}.flac`,
            path,
            source: "netease",
            level: "lossless",
            format: "flac",
            bitrate: 900000,
            sampleRate: 44100,
            bitDepth: 16,
            warnings: [],
          };
        }
        if (cmd === "local_scan") {
          const known = new Set(args.known);
          return {
            folders: [],
            download_folder: "/Downloads/Ting",
            tracks: w.__scan.filter((t: any) => !known.has(t.path)),
          };
        }
        if (cmd === "local_restore") return [];
        if (cmd === "local_lyric")
          return "[00:00.00]本地第一行\n[00:02.00]本地第二行";
        if (cmd === "local_import")
          return [
            {
              id: -11,
              path: "/Music/a.flac",
              name: "夜曲",
              artist: "甲 / 乙",
              album: "夜",
              duration: 6000,
              cover: "",
              origin: null,
              gain: null,
            },
            {
              id: -12,
              path: "/Music/b.flac",
              name: "晨曲",
              artist: "甲",
              album: "晨",
              duration: 6000,
              cover: "",
              origin: null,
              gain: null,
            },
          ];
        if (cmd === "local_store") {
          const name = decodeURIComponent(
            options.headers?.["x-file-name"] || "",
          );
          w.__stored = { name, bytes: args.byteLength ?? args.length };
          return {
            id: -21,
            path: "/App/imported/" + name,
            name: name.replace(/\.[^.]+$/, ""),
            artist: "本地音乐",
            album: "本地导入",
            duration: 6000,
            cover: "",
            origin: null,
            gain: null,
          };
        }
        if (cmd === "song_url")
          return {
            url: "/__file/stream.wav",
            trial: false,
            trialStart: 0,
            bitrate: 320000,
            level: "exhigh",
            requestedLevel: "exhigh",
            format: "mp3",
          };
        if (cmd === "song_lyric") return "[00:00.00]在线歌词";
        return null;
      },
    };
  }, options);
  await page.goto("/");
}
const count = (page: Page, cmd: string) =>
  page.evaluate(
    (name) => (window as any).__calls.filter((c: any) => c.cmd === name).length,
    cmd,
  );

test("an album downloads two songs at a time, lands on the shelf, and failures retry", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 760 });
  await setup(page, { failFirst: true });
  await page.locator('[data-song="netease:1"] [data-album-link]').click();
  await expect(page.locator(".album-hero")).toBeVisible();
  await page.locator("#download-all").click();
  await expect(page.locator("#downloads-button")).toBeVisible();
  await page.locator("#downloads-button").click();
  await expect(page.locator("#downloads-dialog")).toContainText("失败 1 首", {
    timeout: 5000,
  });
  await expect(page.locator("#downloads-dialog")).toContainText("完成 3 首");
  expect(await page.evaluate(() => (window as any).__peak)).toBe(2);
  await page.locator("[data-downloads-retry]").click();
  await expect(page.locator("#downloads-dialog")).toContainText("完成 4 首");
  await page.locator("[data-downloads-close]").click();
  // Every download now shows as saved, and the files are on the local shelf.
  await expect(page.locator(".song-row .downloaded")).toHaveCount(4);
  await page.locator('[data-view="local"]').click();
  await expect(page.locator(".song-row")).toHaveCount(4);
});

test("a downloaded song plays from disk, with its file's lyrics when offline", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 760 });
  await setup(page, {
    scan: [
      {
        id: -1002,
        path: "/Downloads/Ting/歌曲2.flac",
        name: "第二首",
        artist: "测试歌手",
        album: "测试专辑",
        duration: 6000,
        cover: "",
        origin: { source: "netease", id: 2 },
        gain: null,
      },
    ],
  });
  await expect(page.locator('[data-song="netease:2"] .downloaded')).toHaveText(
    "已下载",
  );
  await expect(page.locator('[data-song="netease:1"] .downloaded')).toHaveCount(
    0,
  );
  await page.locator('[data-song="netease:2"]').dblclick();
  await expect(page.locator("#track-tag")).toHaveText("已下载 · 离线播放");
  await expect(page.locator("#download-current")).toBeDisabled();
  expect(await count(page, "song_url")).toBe(0);
  // The other song still streams.
  await page.locator('[data-song="netease:1"]').dblclick();
  await expect.poll(() => count(page, "song_url")).toBe(1);
});

test("waiting downloads survive a restart paused, and continue on request", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 760 });
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("seeded")) {
      sessionStorage.setItem("seeded", "1");
      localStorage.setItem(
        "ting.download-queue",
        JSON.stringify([
          {
            song: {
              id: 1,
              name: "第一首",
              artist: "测试歌手",
              album: "测试专辑",
              cover: "",
              duration: 6000,
              fee: 0,
            },
          },
        ]),
      );
    }
  });
  await setup(page);
  await expect(page.locator("#toast")).toContainText("等待下载");
  await expect(page.locator("#downloads-button .downloads-count")).toHaveText(
    "1",
  );
  expect(await count(page, "download_song")).toBe(0);
  await page.locator("#downloads-button").click();
  await expect(page.locator("#downloads-dialog")).toContainText("已暂停");
  await page.locator("[data-downloads-toggle]").click();
  await expect(page.locator("#downloads-dialog")).toContainText("完成 1 首");
  expect(
    await page.evaluate(() => localStorage.getItem("ting.download-queue")),
  ).toBeNull();
});

test("the local shelf groups by artist and album and each opens its own page", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 760 });
  await setup(page);
  await page.locator('[data-view="local"]').click();
  await page.locator("#empty-import").click();
  await expect(page.locator(".song-row")).toHaveCount(2);
  await page.locator('[data-local-tab="artists"]').click();
  await expect(page.locator(".artist-card")).toHaveCount(2);
  await expect(page.locator(".artist-card").first()).toContainText("甲");
  await page.locator(".artist-card").first().click();
  await expect(page.locator(".artist-hero")).toContainText("本地");
  await expect(page.locator(".song-row")).toHaveCount(2);
  await page.locator("#back-button").click();
  await page.locator('[data-local-tab="albums"]').click();
  await expect(page.locator(".album-card")).toHaveCount(2);
  await page.locator(".album-card").filter({ hasText: "晨" }).click();
  await expect(page.locator(".album-hero")).toContainText("晨");
  await expect(page.locator(".song-row")).toHaveCount(1);
  // Local songs read their own lyrics.
  await page.locator(".song-row").first().dblclick();
  await page.locator("#lyrics-toggle").click();
  await expect(page.locator("#lyrics")).toContainText("本地第一行");
});

test("a phone keeps a copy of what it imports, so the song is there after a restart", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page, { mobile: true });
  await page.locator('[data-view="local"]').click();
  await page
    .locator("#file-input")
    .setInputFiles([
      { name: "晚风.wav", mimeType: "audio/wav", buffer: silence(1) },
    ]);
  await expect(page.locator(".song-row")).toHaveCount(1);
  await expect(page.locator("#toast")).toContainText("重启后仍在");
  const stored = await page.evaluate(() =>
    (window as any).__calls.find((c: any) => c.cmd === "local_store"),
  );
  expect(stored).toBeTruthy();
  await page.reload();
  await page.locator('[data-view="local"]').click();
  await expect(page.locator('[data-song="local:-21"]')).toContainText("晚风");
});
