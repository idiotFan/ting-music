import { test, expect, type Page } from "@playwright/test";

async function fixture(page: Page) {
  await page.addInitScript(() => {
    const w = window as any;
    Object.defineProperty(window, "isTauri", { value: true });
    const songs = [1, 2, 3].map((id) => ({
      id,
      name: `记忆歌曲 ${id}`,
      artist: "记忆歌手",
      album: `记忆专辑 ${id}`,
      cover: "",
      duration: 30000,
      fee: 0,
    }));
    // 30 s of silence so the transport has something real to seek within.
    const wav = new ArrayBuffer(44 + 22050 * 30 * 2);
    const data = new DataView(wav);
    const text = (offset: number, value: string) =>
      [...value].forEach((c, i) => data.setUint8(offset + i, c.charCodeAt(0)));
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
    w.__urlCalls = 0;
    w.__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args: any = {}) => {
        if (cmd === "account_status")
          return { userId: 7, nickname: "记忆账号", avatar: "" };
        if (cmd === "search_songs") return { songs, total: songs.length };
        if (cmd === "song_url") {
          w.__urlCalls++;
          return { url, level: "standard", bitrate: 128000, format: "wav" };
        }
        if (cmd === "song_lyric") return "[00:00.00]记忆歌词";
        if (cmd === "my_playlists")
          return {
            playlists: [11, 12].map((id) => ({
              id,
              name: `记忆歌单 ${id}`,
              cover: "",
              trackCount: 3,
              creator: "记忆账号",
              owned: true,
            })),
            more: false,
          };
        if (cmd === "playlist_tracks")
          return { songs, total: songs.length, nextOffset: songs.length };
        return null;
      },
    };
  });
  await page.goto("/");
  await expect(page.locator(".song-row")).toHaveCount(3);
}

test("the last track comes back after a restart and resumes where it stopped", async ({
  page,
}) => {
  await fixture(page);
  await page.locator(".song-row").nth(1).dblclick();
  await expect(page.locator("body")).toHaveAttribute(
    "data-playback",
    "playing",
  );
  await page.locator("#seek").fill("12");
  await expect
    .poll(() =>
      page.evaluate(
        () => JSON.parse(localStorage.getItem("ting.session") || "{}").position,
      ),
    )
    .toBe(12);
  await page.reload();
  await expect(page.locator(".song-row")).toHaveCount(3);
  // The card shows the track without fetching a stream.
  await expect(page.locator("#now-name")).toHaveText("记忆歌曲 2");
  await expect(page.locator("#track-tag")).toHaveText("上次听到 0:12");
  expect(await page.evaluate(() => (window as any).__urlCalls)).toBe(0);
  await expect(page.locator("body")).toHaveAttribute("data-playback", "paused");
  await expect(page.locator(".song-row.playing .song-title")).toHaveText(
    "记忆歌曲 2",
  );
  await page.locator("#toggle").click();
  await expect(page.locator("body")).toHaveAttribute(
    "data-playback",
    "playing",
  );
  expect(await page.evaluate(() => (window as any).__urlCalls)).toBe(1);
  await expect
    .poll(() =>
      page
        .locator("#seek")
        .evaluate((el) => Number((el as HTMLInputElement).value)),
    )
    .toBeGreaterThanOrEqual(12);
  // Next/previous still follow the restored queue.
  await page.locator("#next").click();
  await expect(page.locator("#now-name")).toHaveText("记忆歌曲 3");
});

test("the list being browsed reopens: a playlist, or favorites", async ({
  page,
}) => {
  await fixture(page);
  await page.locator('[data-view="playlists"]').click();
  await expect(page.locator(".playlist-card")).toHaveCount(2);
  await page.locator('[data-playlist="netease:12"]').click();
  await expect(page.locator("#section-title")).toContainText("记忆歌单 12");
  await expect(page.locator(".song-row")).toHaveCount(3);
  await page.reload();
  await expect(page.locator("#section-title")).toContainText("记忆歌单 12");
  await expect(page.locator(".song-row")).toHaveCount(3);
  await expect(page.locator("#back-button")).toBeVisible();
  // Leaving to another list is remembered too; search is not (it is the default).
  await page.locator('[data-view="favorites"]').click();
  await page.reload();
  await expect(page.locator("#section-title")).toContainText("收藏");
  await page.locator('[data-view="discover"]').click();
  await page.reload();
  await expect(page.locator("#section-title")).toContainText("收藏");
});

test("a playlist that no longer exists falls back to the playlist list", async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(() =>
    localStorage.setItem(
      "ting.session",
      JSON.stringify({
        view: "playlist",
        playlist: { id: 999, name: "已删除", cover: "", trackCount: 0 },
      }),
    ),
  );
  await page.reload();
  await expect(page.locator("#section-title")).toContainText("我的歌单");
  await expect(page.locator(".playlist-card")).toHaveCount(2);
});
