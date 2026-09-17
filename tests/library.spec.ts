import { test, expect } from "@playwright/test";
async function setup(page: any) {
  await page.addInitScript(() => {
    const w = window as any;
    w.__calls = [];
    w.__fail = false;
    const song = (id: number, source = "netease") => ({
      id,
      source,
      mid: source === "qq" ? "mid" + id : undefined,
      name: "歌曲" + id,
      artist: "测试歌手",
      album: "原版专辑",
      cover: "",
      duration: 180000,
      fee: 0,
    });
    const tracks: { [key: string]: any[] } = {
      "netease:88": [song(1), song(2), song(3)],
      "qq:88": Array.from({ length: 137 }, (_, i) => song(i + 1, "qq")),
    };
    w.__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args: any = {}) => {
        const source = cmd === "qq_request" ? "qq" : "netease",
          op = source === "qq" ? args.operation : cmd,
          a = source === "qq" ? args.args : args;
        w.__calls.push({ source, op, args: a });
        if (op === "account_status")
          return { userId: 123, nickname: source + "用户", avatar: "" };
        if (op === "search_songs")
          return {
            songs: [song(source === "qq" ? 41 : 51, source), song(42, source)],
            total: 2,
          };
        if (op === "my_playlists")
          return {
            playlists: [
              {
                source,
                id: 88,
                dirid: 4,
                name: source + "自建",
                cover: "",
                trackCount: source === "qq" ? 137 : 3,
                owned: true,
                creator: "测试",
              },
              {
                source,
                id: 89,
                name: source + "收藏",
                cover: "",
                trackCount: 3,
                owned: false,
                creator: "他人",
              },
            ],
            more: false,
          };
        if (op === "playlist_tracks") {
          const list = tracks[source + ":" + a.id] || [song(1, source)];
          return {
            songs: list.slice(a.offset, a.offset + 100),
            total: list.length,
            nextOffset: Math.min(a.offset + 100, list.length),
          };
        }
        if (op === "playlist_edit") {
          if (w.__fail) throw "写入失败，测试错误";
          const k = source + ":" + a.id;
          if (a.action === "add") tracks[k].push(song(a.trackId, source));
          else if (a.action === "remove")
            tracks[k] = tracks[k].filter((s) => s.id !== a.trackId);
          return;
        }
        if (op === "song_lyric") return "";
        throw new Error("Unexpected " + op);
      },
    };
    Object.defineProperty(window, "isTauri", { value: true });
  });
  await page.goto("/");
  await expect(page.locator("#account-name")).toHaveText("双账号");
}
async function openList(page: any, key = "netease:88") {
  await page.locator('[data-view="playlists"]').click();
  await page
    .locator(
      `[data-playlist-filter="${key.startsWith("qq:") ? "qq" : "netease"}"]`,
    )
    .click();
  await page.locator(`[data-playlist="${key}"]`).click();
}
async function menu(page: any, key: string) {
  await page.locator(`[data-song-menu="${key}"]`).click();
}
test("mixed local playlist persists, reorders, removes, renames and deletes without cloud writes", async ({
  page,
}) => {
  await setup(page);
  await page.setViewportSize({ width: 400, height: 560 });
  await menu(page, "netease:51");
  await page.locator("#song-add").click();
  await page.locator("#create-and-add").click();
  await page.locator("#playlist-name").fill("两个平台");
  await page.getByRole("button", { name: "创建并加入", exact: true }).click();
  await expect(page.locator("#library-dialog")).not.toBeVisible();
  await page.locator("#search-source").selectOption("qq");
  await expect(page.locator('[data-song="qq:41"]')).toBeVisible();
  await menu(page, "qq:41");
  await page.locator("#song-add").click();
  await page.locator('[data-target-filter="internal"]').click();
  await page
    .locator(".playlist-target")
    .filter({ hasText: "两个平台" })
    .click();
  await expect(page.locator("#library-dialog")).not.toBeVisible();
  await page.locator('[data-view="playlists"]').click();
  await page.locator('[data-playlist-filter="internal"]').click();
  await page.locator(".playlist-card").filter({ hasText: "两个平台" }).click();
  await expect(page.locator(".song-row")).toHaveCount(2);
  await menu(page, "qq:41");
  await page.locator('[data-move="top"]').click();
  await expect(page.locator(".song-row").first()).toHaveAttribute(
    "data-song",
    "qq:41",
  );
  await page.reload();
  await page.locator('[data-view="playlists"]').click();
  await page.locator('[data-playlist-filter="internal"]').click();
  await page.locator(".playlist-card").filter({ hasText: "两个平台" }).click();
  await expect(page.locator(".song-row").first()).toHaveAttribute(
    "data-song",
    "qq:41",
  );
  await page.locator("#manage-playlist").click();
  await page.locator("#playlist-name").fill("混合收藏");
  await page.getByRole("button", { name: "保存名称", exact: true }).click();
  await expect(page.locator("#section-title")).toContainText("混合收藏");
  await menu(page, "netease:51");
  await page.locator("#song-remove").click();
  await page.locator("#confirm-remove").click();
  await expect(page.locator(".song-row")).toHaveCount(1);
  await page.locator("#manage-playlist").click();
  await page.locator("#delete-playlist").click();
  await page.locator("#confirm-delete").click();
  await expect(
    page.locator(".playlist-card").filter({ hasText: "混合收藏" }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      (window as any).__calls.filter((c: any) => c.op === "playlist_edit"),
    ),
  ).toHaveLength(0);
});
test("cross-platform match requires explicit selection and sends destination ID only", async ({
  page,
}) => {
  await setup(page);
  await page.locator("#search-source").selectOption("qq");
  await menu(page, "qq:41");
  await page.locator("#song-add").click();
  await page.locator('[data-target-filter="netease"]').click();
  await page
    .locator(".playlist-target")
    .filter({ hasText: "netease自建" })
    .click();
  await expect(page.locator("#match-confirm")).toBeDisabled();
  await expect(page.locator(".match-choice")).toHaveCount(2);
  expect(
    await page.evaluate(() =>
      (window as any).__calls.filter((c: any) => c.op === "playlist_edit"),
    ),
  ).toHaveLength(0);
  await page.locator(".match-choice").first().click();
  await page.screenshot({ path: "work/cross-platform-match.png" });
  await page.locator("#match-confirm").click();
  await expect(page.locator("#library-dialog")).not.toBeVisible();
  expect(
    await page.evaluate(() =>
      (window as any).__calls.find((c: any) => c.op === "playlist_edit"),
    ),
  ).toMatchObject({
    source: "netease",
    args: { id: 88, trackId: 51, action: "add" },
  });
});
test("cloud failures preserve songs, read-only playlists cannot be edited", async ({
  page,
}) => {
  await setup(page);
  await openList(page);
  await menu(page, "netease:1");
  await page.locator("#song-remove").click();
  await page.evaluate(() => {
    (window as any).__fail = true;
  });
  await page.locator("#confirm-remove").click();
  await expect(page.locator("#library-error")).toContainText("写入失败");
  await expect(page.locator(".song-row")).toHaveCount(3);
  await page.locator("#library-close").click();
  await openList(page, "netease:89");
  await menu(page, "netease:1");
  await expect(page.locator("#song-remove")).toHaveCount(0);
  await expect(page.locator("[data-move]")).toHaveCount(0);
  await page.locator("#song-add").click();
  await expect(
    page.locator(".playlist-target").filter({ hasText: "收藏" }),
  ).toHaveCount(0);
});
test("QQ local ordering includes all 137 songs, persists and can restore platform order", async ({
  page,
}) => {
  await setup(page);
  await openList(page, "qq:88");
  await expect(page.locator(".song-row")).toHaveCount(100);
  await menu(page, "qq:1");
  await expect(page.locator("#library-dialog")).toContainText("仅本机");
  await page.locator('[data-move="bottom"]').click();
  await expect(page.locator(".song-row")).toHaveCount(137);
  await expect(page.locator(".song-row").last()).toHaveAttribute(
    "data-song",
    "qq:1",
  );
  await expect(page.locator("#more")).not.toBeVisible();
  await page.reload();
  await openList(page, "qq:88");
  await expect(page.locator(".song-row")).toHaveCount(137);
  await expect(page.locator(".song-row").last()).toHaveAttribute(
    "data-song",
    "qq:1",
  );
  await page.locator("#manage-playlist").click();
  await page.locator("#reset-order").click();
  await expect(page.locator(".song-row").first()).toHaveAttribute(
    "data-song",
    "qq:1",
  );
  expect(
    await page.evaluate(() =>
      (window as any).__calls.filter((c: any) => c.op === "playlist_edit"),
    ),
  ).toHaveLength(0);
});
test("cloud add, remove, reorder are routed to the correct platform", async ({
  page,
}) => {
  await setup(page);
  await menu(page, "netease:51");
  await page.locator("#song-add").click();
  await page
    .locator(".playlist-target")
    .filter({ hasText: "netease自建" })
    .click();
  await expect(page.locator("#library-dialog")).not.toBeVisible();
  await openList(page);
  await expect(page.locator(".song-row")).toHaveCount(4);
  await menu(page, "netease:51");
  await page.locator('[data-move="top"]').click();
  await expect(page.locator("#library-dialog")).not.toBeVisible();
  await openList(page, "qq:88");
  await menu(page, "qq:1");
  await page.locator("#song-remove").click();
  await page.locator("#confirm-remove").click();
  await expect(page.locator("#library-dialog")).not.toBeVisible();
  const writes = await page.evaluate(() =>
    (window as any).__calls.filter((c: any) => c.op === "playlist_edit"),
  );
  expect(
    writes.map((c: any) => [c.source, c.args.action, c.args.trackId]),
  ).toEqual([
    ["netease", "add", 51],
    ["netease", "top", 51],
    ["qq", "remove", 1],
  ]);
});
