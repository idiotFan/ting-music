import { test, expect, type Page } from "@playwright/test";

/** Desktop Tauri with the settings-related commands recorded. */
async function setup(page: Page, extra: { backup?: string } = {}) {
  await page.addInitScript((opts) => {
    const w = window as any;
    Object.defineProperty(window, "isTauri", { value: true });
    w.__calls = [];
    w.__events = [];
    const song = (id: number, name: string) => ({
      id,
      name,
      artist: "测试歌手",
      album: "测试专辑",
      cover: `https://p1.music.126.net/cover-${id}.jpg`,
      duration: 180000,
      fee: 0,
    });
    w.__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      invoke: async (cmd: string, args: any = {}) => {
        w.__calls.push({ cmd, args });
        if (cmd === "plugin:event|emit") {
          w.__events.push(args);
          return null;
        }
        if (cmd === "plugin:event|listen") return 1;
        if (cmd === "search_songs")
          return {
            songs: [1, 2, 3, 4, 5].map((i) => song(i, `歌曲${i}`)),
            total: 5,
          };
        if (cmd === "account_status") return null;
        if (cmd === "catalog_search")
          return { artists: [], albums: [], playlists: [], total: 0 };
        if (cmd === "download_dir")
          return args.pick
            ? "/Volumes/音乐盘/Ting"
            : "/Users/me/Downloads/Ting";
        if (cmd === "diagnostics")
          return {
            version: "0.9.7",
            os: "macos",
            arch: "aarch64",
            family: "unix",
          };
        if (cmd === "backup_save") return "/Users/me/Desktop/" + args.name;
        if (cmd === "backup_open") return opts.backup || "";
        if (cmd === "float_lyrics") return args.show;
        if (cmd === "mini_player") return true;
        if (cmd === "local_restore") return [];
        if (cmd === "local_scan")
          return {
            folders: ["/Music/唱片"],
            download_folder: null,
            tracks: [],
          };
        return null;
      },
    };
  }, extra);
  await page.goto("/");
  await expect(page.locator(".song-row")).toHaveCount(5);
}
const calls = (page: Page, cmd: string) =>
  page.evaluate(
    (c) => (window as any).__calls.filter((x: any) => x.cmd === c),
    cmd,
  );

test("settings gather scale, downloads, tray and shortcuts, and each change takes effect", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 780 });
  await setup(page);
  await page.locator("#settings-button").click();
  const dialog = page.locator("#settings-dialog");
  await expect(dialog).toContainText("版本 0.9.7");
  await expect(dialog).toContainText("/Music/唱片");
  await expect(dialog).toContainText("/Users/me/Downloads/Ting");

  await dialog.locator('[data-scale="1.25"]').click();
  expect(await page.evaluate(() => document.documentElement.style.zoom)).toBe(
    "1.25",
  );
  await page.keyboard.press("ControlOrMeta+-");
  expect(await page.evaluate(() => localStorage.getItem("ting.scale"))).toBe(
    "1.1",
  );

  await dialog.locator('[data-download-dir="pick"]').click();
  await expect(dialog).toContainText("/Volumes/音乐盘/Ting");

  await dialog.locator("#settings-tray").check();
  await expect
    .poll(
      async () =>
        (await calls(page, "desktop_prefs")).at(-1)?.args.prefs.close_to_tray,
    )
    .toBe(true);

  await dialog.locator("#settings-shortcuts").check();
  await expect(dialog.locator(".shortcut-row")).toHaveCount(7);
  await dialog.locator('[data-record="next"]').click();
  await expect(dialog.locator('[data-record="next"]')).toHaveText(
    "请按下新组合…",
  );
  await page.keyboard.press("Control+Alt+KeyK");
  await expect
    .poll(
      async () =>
        (await calls(page, "desktop_prefs")).at(-1)?.args.prefs.shortcuts.next,
    )
    .toMatch(/Alt\+K$/);
  // Escape while recording cancels the recording, not the sheet.
  await dialog.locator('[data-record="toggle"]').click();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-record="toggle"]')).not.toHaveText(
    "请按下新组合…",
  );
});

test("a backup exports the library and a backup file merges back in", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 780 });
  const backup = JSON.stringify({
    app: "ting",
    format: 1,
    exportedAt: "2026-09-23T00:00:00Z",
    library: {
      playlists: [
        {
          internal: true,
          id: 42,
          name: "来自备份",
          cover: "",
          creator: "本机",
          owned: true,
          trackCount: 1,
          songs: [
            {
              id: 9,
              name: "备份歌曲",
              artist: "A",
              album: "B",
              cover: "",
              duration: 1000,
              fee: 0,
            },
          ],
        },
      ],
      favorites: [
        {
          id: 8,
          name: "备份收藏",
          artist: "A",
          album: "B",
          cover: "",
          duration: 1000,
          fee: 0,
        },
      ],
    },
    locals: [],
    localMembers: {},
    history: [],
    preferences: { "ting.theme": "rose", "ting.session": "ignored" },
  });
  await setup(page, { backup });
  await page.locator('[data-favorite="netease:1"]').click();
  await page.locator("#settings-button").click();
  await page.locator('[data-backup="export"]').click();
  await expect(page.locator("#toast")).toContainText("备份已保存");
  const saved = (await calls(page, "backup_save"))[0].args;
  expect(saved.name).toMatch(/^ting-backup-\d{4}-\d{2}-\d{2}\.json$/);
  const content = JSON.parse(saved.content);
  expect(content.library.favorites.map((s: any) => s.id)).toEqual([1]);

  await page.locator('[data-backup="import"]').click();
  await expect(page.locator("#toast")).toContainText("新增歌单 1 个");
  await page.waitForLoadState("load");
  await expect(page.locator(".song-row")).toHaveCount(5, { timeout: 8000 });
  await expect(page.locator("#fav-count")).toHaveText("2");
  expect(
    await page.evaluate(() => document.documentElement.dataset.theme),
  ).toBe("rose");
  expect(
    await page.evaluate(() => localStorage.getItem("ting.session")),
  ).not.toBe("ignored");
  await page.locator('[data-view="playlists"]').click();
  await page.locator('[data-playlist-filter="internal"]').click();
  await expect(page.locator(".playlist-card")).toContainText("来自备份");
});

test("diagnostics export carries versions and recent errors, never addresses' queries", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 780 });
  await setup(page);
  await page.evaluate(() => {
    const t = document.querySelector("#toast")!;
    void t;
  });
  await page.evaluate(() =>
    window.dispatchEvent(
      new ErrorEvent("error", {
        message: "load https://m801.music.126.net/x.flac?vuutv=SECRET failed",
      }),
    ),
  );
  await page.locator("#settings-button").click();
  await page.locator("[data-diagnostics]").click();
  await expect(page.locator("#toast")).toContainText("诊断信息已保存");
  const saved = (await calls(page, "backup_save")).at(-1).args;
  expect(saved.name).toMatch(/^ting-diagnostics-/);
  expect(saved.content).toContain('"version": "0.9.7"');
  expect(saved.content).toContain("x.flac?…");
  expect(saved.content).not.toContain("SECRET");
});

test("following the system switches between the light and dark choices", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 780 });
  await page.emulateMedia({ colorScheme: "light" });
  await setup(page);
  await page.locator("#theme-button").click();
  await page.locator("#theme-follow").check();
  expect(
    await page.evaluate(() => document.documentElement.dataset.theme),
  ).toBe("sage");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
    .toBe("midnight");
  // Picking a dark palette now fills the dark slot.
  await page.locator('[data-theme-choice="graphite"]').click();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
    .toBe("graphite");
  await page.emulateMedia({ colorScheme: "light" });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
    .toBe("sage");
  await page.reload();
  expect(
    await page.evaluate(() => document.documentElement.dataset.theme),
  ).toBe("sage");
});

test("picking several songs acts on all of them at once", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 780 });
  await setup(page);
  await page
    .locator('[data-song="netease:1"]')
    .click({ modifiers: ["ControlOrMeta"] });
  await expect(page.locator("#selection-bar")).toBeVisible();
  await page.locator('[data-song="netease:4"]').click({ modifiers: ["Shift"] });
  await expect(page.locator("#selection-count")).toHaveText("已选 4 首");
  await page.locator('[data-song="netease:2"]').click();
  await expect(page.locator("#selection-count")).toHaveText("已选 3 首");
  await expect(page.locator("#now-name")).not.toHaveText("歌曲2");
  await page.locator('[data-sel="favorite"]').click();
  await expect(page.locator("#fav-count")).toHaveText("3");
  await expect(page.locator("#selection-bar")).toBeHidden();

  await page.locator("#select-mode").click();
  await page.locator('[data-sel="all"]').click();
  await expect(page.locator("#selection-count")).toHaveText("已选 5 首");
  await page.locator('[data-sel="queue"]').click();
  await expect(page.locator("#queue-count")).toHaveText("5");
  // Escape leaves picking without leaving the page.
  await page.locator("#select-mode").click();
  await page.keyboard.press("Escape");
  await expect(page.locator("#selection-bar")).toBeHidden();
});

test("a local playlist can show a four-cover grid", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 780 });
  await setup(page);
  await page.locator("#select-mode").click();
  await page.locator('[data-sel="all"]').click();
  await page.locator('[data-sel="playlist"]').click();
  await expect(page.locator("#library-dialog")).toContainText(
    "把 5 首加入歌单",
  );
  await page
    .locator("#library-dialog [data-target]")
    .first()
    .waitFor({ state: "detached", timeout: 1000 })
    .catch(() => {});
  // No local playlist yet: create one from the first song, then add the rest.
  await page.keyboard.press("Escape");
  await page.locator('[data-song-menu="netease:1"]').click();
  await page.locator("#song-add").click();
  await page.locator("#create-and-add").click();
  await page.locator("#playlist-name").fill("拼图歌单");
  await page.getByRole("button", { name: "创建并加入", exact: true }).click();
  await expect(page.locator("#library-dialog")).not.toBeVisible();
  await page.locator("#select-mode").click();
  await page.locator('[data-sel="all"]').click();
  await page.locator('[data-sel="playlist"]').click();
  await page
    .locator(".playlist-target")
    .filter({ hasText: "拼图歌单" })
    .click();
  await expect(page.locator("#library-dialog")).not.toBeVisible();
  await page.locator('[data-view="playlists"]').click();
  await page.locator('[data-playlist-filter="internal"]').click();
  await page.locator(".playlist-card").filter({ hasText: "拼图歌单" }).click();
  await expect(page.locator(".song-row")).toHaveCount(5);
  await page.locator("#manage-playlist").click();
  await page.locator('[data-cover="grid"]').click();
  await page.keyboard.press("Escape");
  await page.locator("#back-button").click();
  await expect(
    page.locator(".playlist-card .playlist-art.grid img"),
  ).toHaveCount(4);
});

test("floating lyrics and the mini player are driven from settings", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 780 });
  await setup(page);
  await page.locator("#settings-button").click();
  await page.locator("[data-float-lyrics]").click();
  await expect
    .poll(async () => (await calls(page, "float_lyrics")).length)
    .toBe(1);
  await expect(page.locator("[data-float-lock]")).toBeVisible();
  await page.locator("[data-float-lock]").click();
  expect((await calls(page, "float_lyrics_lock")).at(-1).args.locked).toBe(
    true,
  );
  await page.locator("[data-mini]").click();
  await expect
    .poll(async () => (await calls(page, "mini_player")).length)
    .toBe(1);
  await page.keyboard.press("Escape");
  await page.locator('[data-song="netease:1"]').dblclick();
  // The helper windows hear what is playing.
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).__events.some((e: any) => e.event === "player-state"),
      ),
    )
    .toBe(true);
});

test("on a phone, settings is a full-screen grouped list with a Done button", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "userAgent", {
      value:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
    }),
  );
  await setup(page);
  await page.locator("#settings-button").click();
  const dialog = page.locator("#settings-dialog");
  await expect(dialog.locator(".sheet-done")).toHaveText("完成");
  const box = (await dialog.boundingBox())!;
  expect(box.width).toBe(390);
  expect(box.height).toBeGreaterThan(800);
  // Every tappable row is at least 44 pt tall.
  for (const height of await dialog
    .locator(".cell")
    .evaluateAll((cells) => cells.map((c) => c.getBoundingClientRect().height)))
    expect(height).toBeGreaterThanOrEqual(44);
  // The switch flips from its label, and the sound sheet opens on top.
  await dialog.locator("label.cell", { hasText: "下载后自动加入本地" }).click();
  expect(
    await page.evaluate(() => localStorage.getItem("ting.auto-import")),
  ).toBe("0");
  await dialog.locator("[data-open-sound]").click();
  await expect(page.locator("#sound-dialog")).toBeVisible();
  await expect(dialog).toBeVisible();
  await page.locator("[data-sound-close]").click();
  await dialog.locator(".sheet-done").click();
  await expect(dialog).toBeHidden();
});
