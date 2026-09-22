import { test, expect, type Page } from "@playwright/test";

/** Desktop Tauri with a native picker that answers with remembered files. */
async function setup(page: Page, options: { missing?: string[] } = {}) {
  await page.addInitScript((opts) => {
    const w = window as any;
    Object.defineProperty(window, "isTauri", { value: true });
    w.__calls = [];
    w.__picks = [
      {
        id: -101,
        path: "/Music/晚风.flac",
        name: "晚风",
        artist: "本地歌手",
        album: "夜曲",
        duration: 201000,
        cover: "",
      },
      {
        id: -102,
        path: "/Music/清晨.mp3",
        name: "清晨",
        artist: "本地歌手",
        album: "日出",
        duration: 150000,
        cover: "/cache/local-covers/66.jpg",
      },
    ];
    w.__TAURI_INTERNALS__ = {
      convertFileSrc: (path: string) =>
        "asset://localhost/" + encodeURIComponent(path),
      invoke: async (cmd: string, args: any = {}) => {
        w.__calls.push({ cmd, args });
        if (cmd === "local_import") return w.__picks;
        if (cmd === "local_restore") return opts.missing || [];
        if (cmd === "search_songs")
          return {
            songs: [
              {
                id: 51,
                source: "netease",
                name: "在线歌曲",
                artist: "网易歌手",
                album: "专辑",
                cover: "",
                duration: 180000,
                fee: 0,
              },
            ],
            total: 1,
          };
        if (cmd === "account_status") return null;
        if (cmd === "my_playlists") return { playlists: [], more: false };
        return null;
      },
    };
  }, options);
  await page.goto("/");
}

test("imported files are remembered, join favorites and local playlists, and stay off the sync store", async ({
  page,
}) => {
  await setup(page);
  await page.setViewportSize({ width: 1100, height: 720 });
  await page.locator('[data-view="local"]').click();
  await page.locator("#empty-import").click();
  await expect(page.locator(".song-row")).toHaveCount(2);
  await expect(page.locator('[data-song="local:-101"]')).toContainText("本地");
  await expect(page.locator('[data-song="local:-102"] img')).toHaveAttribute(
    "src",
    /asset:\/\/localhost\/%2Fcache%2Flocal-covers%2F66\.jpg/,
  );
  // Picking the same file twice only refreshes its tags.
  await page.locator("#import-top").click();
  await expect(page.locator(".song-row")).toHaveCount(2);

  await page.locator('[data-favorite="local:-101"]').click();
  await expect(page.locator("#fav-count")).toHaveText("1");
  await page.locator('[data-song-menu="local:-102"]').click();
  await expect(page.locator("#library-dialog")).toContainText("本地音乐");
  await page.locator("#song-add").click();
  await expect(page.locator(".target-filters")).toBeHidden();
  await page.locator("#create-and-add").click();
  await page.locator("#playlist-name").fill("离线精选");
  await page.getByRole("button", { name: "创建并加入", exact: true }).click();
  await expect(page.locator("#library-dialog")).not.toBeVisible();

  await page.locator('[data-view="playlists"]').click();
  await page.locator('[data-playlist-filter="internal"]').click();
  await page.locator(".playlist-card").filter({ hasText: "离线精选" }).click();
  await expect(page.locator(".song-row")).toHaveCount(1);
  await expect(page.locator('[data-song="local:-102"]')).toBeVisible();

  const stored = await page.evaluate(() => ({
    playlists: localStorage.getItem("ting.playlists") || "",
    sync: localStorage.getItem("ting.library-sync.v1") || "",
    locals: JSON.parse(localStorage.getItem("ting.locals") || "[]"),
    members: JSON.parse(localStorage.getItem("ting.local-members") || "{}"),
  }));
  expect(stored.playlists + stored.sync).not.toContain("localPath");
  expect(stored.locals).toHaveLength(2);
  expect(stored.locals[0].localUrl).toBeUndefined();
  expect(Object.values(stored.members).flat()).toHaveLength(2);

  await page.reload();
  await page.locator('[data-view="local"]').click();
  await expect(page.locator(".song-row")).toHaveCount(2);
  await page.locator('[data-view="favorites"]').click();
  await expect(page.locator('[data-song="local:-101"]')).toBeVisible();
  const restore = await page.evaluate(() =>
    (window as any).__calls.filter((c: any) => c.cmd === "local_restore"),
  );
  expect(restore).toHaveLength(1);
  expect(restore[0].args.paths).toEqual([
    "/Music/晚风.flac",
    "/Music/清晨.mp3",
  ]);
});

test("a remembered file that vanished is flagged instead of played, and can be forgotten", async ({
  page,
}) => {
  await setup(page);
  await page.setViewportSize({ width: 1100, height: 720 });
  await page.locator('[data-view="local"]').click();
  await page.locator("#empty-import").click();
  await expect(page.locator(".song-row")).toHaveCount(2);
  await page.locator('[data-song="local:-101"]').dblclick();
  await expect(page.locator("#now-name")).toHaveText("晚风");

  // The next launch answers that the first file is gone.
  await page.addInitScript(() => {
    const w = window as any;
    const invoke = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = async (cmd: string, args: any) =>
      cmd === "local_restore" ? ["/Music/晚风.flac"] : invoke(cmd, args);
  });
  await page.reload();
  // The local view and the last song come back; the missing file is flagged.
  await expect(page.locator('[data-view="local"]')).toHaveClass(/active/);
  await expect(page.locator('[data-song="local:-101"]')).toContainText(
    "文件丢失",
  );
  await expect(page.locator("#now-name")).toHaveText("晚风");
  await page.locator("#toggle").click();
  await expect(page.locator("#track-tag")).toHaveText("文件丢失");
  await expect(page.locator("#toast")).toContainText("已不存在");

  await page.locator('[data-song-menu="local:-102"]').click();
  await page.locator("#song-forget").click();
  await page.locator("#confirm-forget").click();
  await expect(page.locator("#library-dialog")).not.toBeVisible();
  await expect(page.locator(".song-row")).toHaveCount(1);
  const locals = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("ting.locals") || "[]"),
  );
  expect(locals.map((s: any) => s.localPath)).toEqual(["/Music/晚风.flac"]);
});
