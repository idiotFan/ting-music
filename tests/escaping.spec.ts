import { test, expect, type Page } from "@playwright/test";

const payload = `<img src=x onerror="window.__pwned=1"><b id="pwn">x</b>`;

async function setup(page: Page) {
  await page.addInitScript((payload: string) => {
    const w = window as any;
    Object.defineProperty(window, "isTauri", { value: true });
    const songs = [1, 2, 3].map((id) => ({
      id,
      name: `${payload} 歌曲 ${id}`,
      artist: `${payload} 歌手`,
      album: `${payload} 专辑`,
      cover: `" onerror="window.__pwned=1`,
      duration: 20000,
      fee: 0,
    }));
    localStorage.setItem("ting.favorites", JSON.stringify(songs));
    localStorage.setItem("ting.playlist-filter", "netease");
    w.__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args: any = {}) => {
        const operation = cmd === "qq_request" ? args.operation : cmd;
        if (operation === "account_status")
          return { userId: 123, nickname: payload, avatar: "" };
        if (operation === "search_songs") return { songs, total: songs.length };
        if (operation === "my_playlists")
          return {
            playlists: [
              {
                id: 100,
                name: `${payload} 歌单`,
                cover: "",
                trackCount: songs.length,
                creator: payload,
                owned: true,
              },
            ],
            more: false,
          };
        if (operation === "playlist_tracks")
          return { songs, total: songs.length, nextOffset: songs.length };
        return null;
      },
    };
  }, payload);
}

async function expectInert(page: Page) {
  await expect(page.locator("#pwn")).toHaveCount(0);
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__pwned)).toBeUndefined();
}

test("song, playlist and search metadata render as text, never as markup", async ({
  page,
}) => {
  await setup(page);
  await page.goto("/");
  await expect(page.locator(".song-row")).toHaveCount(3);
  await expect(page.locator(".song-row").first()).toContainText("<b id=");
  await expectInert(page);

  await page.locator('[data-view="playlists"]').click();
  await expect(page.locator(".playlist-card")).toHaveCount(1);
  await expect(page.locator(".playlist-card strong")).toContainText("<img");
  await page.locator(".playlist-card").click();
  await expect(page.locator(".song-row")).toHaveCount(3);
  await expectInert(page);

  await page.locator('[data-view="discover"]').click();
  await page.locator("#search").fill(payload);
  await page.locator("#search").press("Enter");
  await expect(page.locator(".song-row")).toHaveCount(3);
  await page.locator(".song-row").first().dblclick();
  await expect(page.locator("#now-name")).toContainText("<img");
  await expectInert(page);
});
