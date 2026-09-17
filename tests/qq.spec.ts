import { test, expect } from "@playwright/test";
import QRCode from "qrcode";
import { PNG } from "pngjs";
import jsQR from "jsqr";
import { readFileSync, existsSync } from "node:fs";
async function setup(page: any, image?: string) {
  const qr =
    image ||
    (await QRCode.toDataURL("https://ptlogin2.qq.com/test-login-only", {
      margin: 4,
      scale: 4,
    }));
  await page.addInitScript(
    ({ qr }: any) => {
      const w = window as any;
      w.__calls = [];
      w.__qq = false;
      w.__net = true;
      w.__qrCode = 801;
      const wav = new ArrayBuffer(44 + 44100 * 30 * 2),
        d = new DataView(wav);
      const str = (o: number, s: string) =>
        [...s].forEach((c, i) => d.setUint8(o + i, c.charCodeAt(0)));
      str(0, "RIFF");
      d.setUint32(4, wav.byteLength - 8, true);
      str(8, "WAVEfmt ");
      d.setUint32(16, 16, true);
      d.setUint16(20, 1, true);
      d.setUint16(22, 1, true);
      d.setUint32(24, 44100, true);
      d.setUint32(28, 88200, true);
      d.setUint16(32, 2, true);
      d.setUint16(34, 16, true);
      str(36, "data");
      d.setUint32(40, wav.byteLength - 44, true);
      const url = URL.createObjectURL(new Blob([wav], { type: "audio/wav" }));
      const song = (source: string) => ({
        source,
        id: 42,
        mid: source === "qq" ? "qqmid" : undefined,
        name: "同名曲",
        artist: "歌手",
        album: "专辑",
        cover: "",
        duration: 30000,
        fee: 0,
      });
      w.__TAURI_INTERNALS__ = {
        invoke: async (cmd: string, args: any) => {
          const source = cmd === "qq_request" ? "qq" : "netease";
          const op = source === "qq" ? args.operation : cmd;
          const a = source === "qq" ? args.args : args;
          w.__calls.push({ source, op, args: a });
          if (op === "account_status")
            return (source === "qq" ? w.__qq : w.__net)
              ? { userId: 123, nickname: source + "用户", avatar: "" }
              : null;
          if (op === "login_qr_start") return { key: "key", image: qr };
          if (op === "login_qr_cancel") return;
          if (op === "login_qr_check") {
            if (w.__qrCode === 803) w.__qq = true;
            return {
              code: w.__qrCode,
              profile: w.__qq
                ? { userId: 456, nickname: "QQ用户", avatar: "" }
                : null,
            };
          }
          if (op === "logout") {
            if (source === "qq") w.__qq = false;
            else w.__net = false;
            return;
          }
          if (op === "search_songs") return { songs: [song(source)], total: 1 };
          if (op === "my_playlists") {
            if (source === "qq" && w.__qqListError) throw "QQ 临时失败";
            return {
              playlists: [
                {
                  source,
                  id: 88,
                  name: "同名歌单",
                  cover: "",
                  trackCount: 1,
                  creator: "测试",
                  owned: true,
                },
              ],
              more: false,
            };
          }
          if (op === "playlist_tracks")
            return { songs: [song(source)], total: 1, nextOffset: 1 };
          if (op === "song_url")
            return {
              url,
              trial: false,
              trialStart: 0,
              bitrate: 320000,
              format: "wav",
              level: a.level === "best" ? "lossless" : a.level,
            };
          if (op === "song_lyric") return "[00:00]测试歌词";
          throw new Error("unexpected " + op);
        },
      };
      Object.defineProperty(window, "isTauri", { value: true });
    },
    { qr },
  );
  await page.goto("/");
  await expect(page.locator(".song-row")).toHaveCount(1);
}
async function loginQq(page: any) {
  await page.locator("#account-button").click();
  await page.locator("#account-qq").click();
  await expect(page.locator("#login-qr")).toBeVisible();
  await page.evaluate(() => {
    (window as any).__qrCode = 803;
  });
  await expect(page.locator("#account-dialog")).not.toBeVisible({
    timeout: 5000,
  });
  await expect(page.locator("#account-name")).toHaveText("双账号");
}
test("dual login preserves both accounts, separates same IDs and logout preserves other playback", async ({
  page,
}) => {
  await setup(page);
  await loginQq(page);
  await expect(page.locator(".playlist-card")).toHaveCount(1);
  await expect(page.locator('[data-playlist="netease:88"]')).toContainText(
    "网易云",
  );
  await page.locator('[data-playlist-filter="qq"]').click();
  await expect(page.locator('[data-playlist="qq:88"]')).toContainText("QQ音乐");
  await page.locator('[data-playlist="qq:88"]').click();
  await page.locator('[data-favorite="qq:42"]').click();
  await page.locator('[data-enqueue="qq:42"]').click();
  await page.locator('[data-view="discover"]').click();
  await page.locator('[data-favorite="netease:42"]').click();
  await page.locator('[data-enqueue="netease:42"]').click();
  await expect(page.locator("#queue-count")).toHaveText("2");
  await expect(page.locator("#fav-count")).toHaveText("2");
  await page.locator('[data-view="queue"]').click();
  await expect(page.locator(".song-row")).toHaveCount(2);
  await page.locator('[data-song="netease:42"]').dblclick();
  await page.locator("#quality").selectOption("best");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).__calls.filter((x: any) => x.op === "song_url").at(-1)
            .args.level,
      ),
    )
    .toBe("jymaster");
  await page.locator('[data-song="qq:42"]').dblclick();
  await expect(page.locator("#track-tag")).toContainText("无损");
  expect(
    await page.evaluate(() =>
      (window as any).__calls.filter((x: any) => x.op === "song_url").at(-1),
    ),
  ).toMatchObject({
    source: "qq",
    args: { id: 42, mid: "qqmid", level: "best" },
  });
  await page.locator('[data-song="netease:42"]').dblclick();
  await page.locator("#account-button").click();
  await page.locator("#logout").click();
  await expect(page.locator("#account-name")).toHaveText("netease用户");
  await expect(page.locator("#toggle")).toHaveAttribute("aria-label", "暂停");
  await expect(page.locator("#now-artist")).toContainText("网易云");
  await page.reload();
  await page.locator('[data-view="favorites"]').click();
  await expect(page.locator(".song-row")).toHaveCount(2);
});
test("QQ QR shown at original pixels, decodes exactly, and small window remains usable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 400, height: 560 });
  await setup(page);
  await page.locator("#account-button").click();
  await page.locator("#account-qq").click();
  const qr = page.locator("#login-qr");
  await expect(qr).toBeVisible();
  const src = (await qr.getAttribute("src"))!;
  const original = PNG.sync.read(Buffer.from(src.split(",")[1], "base64"));
  const shown = PNG.sync.read(await qr.screenshot());
  expect(shown.width).toBe(original.width);
  expect(shown.height).toBe(original.height);
  expect(shown.data.equals(original.data)).toBe(true);
  expect(
    jsQR(new Uint8ClampedArray(shown.data), shown.width, shown.height)?.data,
  ).toBe("https://ptlogin2.qq.com/test-login-only");
  await page.screenshot({ path: "work/qq-small.png" });
  await page.locator("#account-netease").click();
  await expect(page.locator(".account-profile")).toContainText("netease用户");
  expect(
    await page.evaluate(() =>
      (window as any).__calls.some(
        (x: any) => x.source === "qq" && x.op === "login_qr_cancel",
      ),
    ),
  ).toBe(true);
});
test("one playlist source failing leaves other source available", async ({
  page,
}) => {
  await setup(page);
  await loginQq(page);
  await page.evaluate(() => {
    (window as any).__qqListError = true;
  });
  await page.locator("#refresh-playlists").click();
  await expect(page.locator(".playlist-card")).toHaveCount(1);
  await expect(page.locator("#error")).toContainText("QQ");
  await expect(page.locator(".playlist-card")).toContainText("网易云");
});
test("real platform-issued QQ QR decodes and is displayed pixel-identically", async ({
  page,
}) => {
  test.skip(
    !existsSync("work/qq-original.png"),
    "Live QR fixture only available during release verification",
  );
  const bytes = readFileSync("work/qq-original.png");
  await page.setViewportSize({ width: 400, height: 560 });
  await setup(page, "data:image/png;base64," + bytes.toString("base64"));
  await page.locator("#account-button").click();
  await page.locator("#account-qq").click();
  const qr = page.locator("#login-qr");
  await expect(qr).toBeVisible();
  const original = PNG.sync.read(bytes),
    shown = PNG.sync.read(await qr.screenshot());
  const scale = shown.width / original.width;
  expect(Number.isInteger(scale)).toBe(true);
  const expected = Buffer.alloc(shown.data.length);
  for (let y = 0; y < shown.height; y++)
    for (let x = 0; x < shown.width; x++)
      for (let c = 0; c < 4; c++)
        expected[(y * shown.width + x) * 4 + c] =
          original.data[
            (Math.floor(y / scale) * original.width + Math.floor(x / scale)) *
              4 +
              c
          ];
  expect(shown.data.equals(expected)).toBe(true);
  expect(
    jsQR(new Uint8ClampedArray(shown.data), shown.width, shown.height)?.data,
  ).toBe(
    jsQR(new Uint8ClampedArray(original.data), original.width, original.height)
      ?.data,
  );
  await page.screenshot({ path: "work/qq-real-small.png" });
});

for (const viewport of [
  { width: 400, height: 560 },
  { width: 480, height: 720 },
]) {
  test(`470px WeChat QR fits ${viewport.width}px window and final pixels decode to original`, async ({
    page,
  }) => {
    const src =
      "data:image/jpeg;base64," +
      readFileSync("tests/fixtures/wechat-login-470.jpg").toString("base64");
    await page.setViewportSize(viewport);
    await setup(page, src);
    const originalPixels = await page.evaluate(async (src) => {
      const image = new Image();
      image.src = src;
      await image.decode();
      const c = document.createElement("canvas");
      c.width = image.naturalWidth;
      c.height = image.naturalHeight;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(image, 0, 0);
      return {
        width: c.width,
        height: c.height,
        data: Array.from(ctx.getImageData(0, 0, c.width, c.height).data),
      };
    }, src);
    const originalCode = jsQR(
      new Uint8ClampedArray(originalPixels.data),
      originalPixels.width,
      originalPixels.height,
    );
    expect(originalCode?.data).toBe(
      "https://example.com/ting/test/wechat-qr?fixture=synthetic-470",
    );
    await page.locator("#account-button").click();
    await page.locator("#account-qq").click();
    await page.locator('[data-qq-kind="wx"]').click();
    const qr = page.locator("#login-qr");
    await expect(qr).toBeVisible();
    const shown = PNG.sync.read(await qr.screenshot());
    expect(shown.width).toBe(251);
    expect(shown.height).toBe(251);
    expect(
      jsQR(new Uint8ClampedArray(shown.data), shown.width, shown.height)?.data,
    ).toBe(originalCode!.data);
    const finalSrc = (await qr.getAttribute("src"))!;
    expect(
      shown.data.equals(
        PNG.sync.read(Buffer.from(finalSrc.split(",")[1], "base64")).data,
      ),
    ).toBe(true);
    const bounds = await qr.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
    await expect(page.locator("#refresh-qr")).toBeInViewport();
    await expect(page.locator("#account-status")).toContainText("等待扫码");
    await page.screenshot({ path: `work/wechat-fixed-${viewport.width}.png` });
  });
}

test("platform tabs separate 100 NetEase playlists; successful playback updates persistent recent order", async ({
  page,
}) => {
  await setup(page);
  await loginQq(page);
  await page.evaluate(() => {
    const w = window as any,
      original = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = async (cmd: string, args: any) => {
      if (cmd === "my_playlists")
        return {
          playlists: Array.from({ length: 100 }, (_, i) => ({
            id: i + 1,
            source: "netease",
            name: `网易歌单 ${i + 1}`,
            cover: "",
            trackCount: 1,
            creator: "测试",
            owned: true,
          })),
          more: false,
        };
      if (cmd === "song_url" && w.__failPlayback) throw "测试播放失败";
      return original(cmd, args);
    };
  });
  await page.locator("#refresh-playlists").click();
  await expect(page.locator(".playlist-card")).toHaveCount(100);
  await page.locator('[data-playlist-filter="qq"]').click();
  await expect(page.locator(".playlist-card")).toHaveCount(1);
  await expect(page.locator(".playlist-card")).toContainText("QQ音乐");
  await expect(page.locator("#more")).not.toBeVisible();
  await page.locator('[data-playlist="qq:88"]').click();
  await page.locator(".song-row").dblclick();
  await expect(page.locator("#toggle")).toHaveAttribute("aria-label", "暂停");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("ting.playlist-recent") || "[]")
            .length,
      ),
    )
    .toBe(1);
  await page.locator('[data-view="playlists"]').click();
  await page.locator('[data-playlist-filter="netease"]').click();
  await page.locator('[data-playlist="netease:99"]').click();
  await page.locator(".song-row").dblclick();
  await expect(page.locator("#now-artist")).toContainText("网易云");
  await expect(page.locator("#toggle")).toHaveAttribute("aria-label", "暂停");
  await page.locator('[data-view="playlists"]').click();
  await expect(page.locator(".playlist-card").first()).toHaveAttribute(
    "data-playlist",
    "netease:99",
  );
  await page.locator('[data-playlist-filter="recent"]').click();
  await expect(page.locator(".playlist-card")).toHaveCount(2);
  await expect(page.locator(".playlist-card").first()).toHaveAttribute(
    "data-playlist",
    "netease:99",
  );
  await page.screenshot({ path: "work/recent-playlists.png" });
  await page.locator('[data-playlist-filter="netease"]').click();
  await page.locator('[data-playlist="netease:50"]').click();
  await page.evaluate(() => {
    (window as any).__failPlayback = true;
  });
  await page.locator(".song-row").dblclick();
  await expect(page.locator("#track-tag")).toHaveText("播放未成功");
  await page.locator('[data-view="playlists"]').click();
  await page.locator('[data-playlist-filter="recent"]').click();
  await expect(page.locator(".playlist-card")).toHaveCount(2);
  await page.reload();
  await page.locator('[data-view="playlists"]').click();
  await expect(page.locator('[data-playlist-filter="recent"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator('[data-playlist="netease:99"]')).toBeVisible();
});

test("QQ download uses QQ identity, shows actual master quality and leaves playback running", async ({
  page,
}) => {
  await setup(page);
  await loginQq(page);
  await page.locator('[data-view="discover"]').click();
  await page.locator("#search-source").selectOption("qq");
  await page.locator('[data-song="qq:42"]').dblclick();
  await expect(page.locator("#toggle")).toHaveAttribute("aria-label", "暂停");
  await page.evaluate(() => {
    const w = window as any,
      original = w.__TAURI_INTERNALS__.invoke;
    w.__downloads = [];
    w.__TAURI_INTERNALS__.invoke = async (cmd: string, args: any) => {
      if (cmd === "download_song") {
        w.__downloads.push(args);
        await new Promise((r) => setTimeout(r, 300));
        return {
          path: "/tmp/QQ.flac",
          filename: "QQ.flac",
          source: "qq",
          level: "master",
          format: "flac",
          bitrate: 0,
          sampleRate: 96000,
          bitDepth: 24,
          warnings: [],
        };
      }
      return original(cmd, args);
    };
  });
  await expect(page.locator("#download-current")).toBeEnabled();
  await page.locator("#download-current").click();
  await expect(page.locator("#download-current")).toBeDisabled();
  await expect(page.locator("#download-status")).toContainText(
    "QQ音乐 · 臻品母带 · FLAC · 24bit / 96kHz",
  );
  await expect(page.locator("#toggle")).toHaveAttribute("aria-label", "暂停");
  expect(await page.evaluate(() => (window as any).__downloads)).toEqual([
    { id: 42, source: "qq" },
  ]);
});
