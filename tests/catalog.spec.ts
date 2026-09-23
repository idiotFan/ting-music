import { test, expect, type Page } from "@playwright/test";

/** Two platforms with artists, albums and public playlists behind them. */
async function setup(page: Page, options: { mobile?: boolean } = {}) {
  await page.addInitScript(() => {
    const w = window as any;
    Object.defineProperty(window, "isTauri", { value: true });
    w.__calls = [];
    const jay = (source: string) =>
      source === "qq"
        ? { id: 4558, mid: "0025NhlN2yWrP4", name: "周杰伦" }
        : { id: 6452, name: "周杰伦" };
    const song = (
      source: string,
      id: number,
      name: string,
      extra: any = {},
    ) => ({
      id,
      source,
      ...(source === "qq" ? { mid: "m" + id } : {}),
      name,
      artist: "周杰伦",
      artists: [jay(source)],
      album: "叶惠美",
      albumId: source === "qq" ? 8220 : 18905,
      ...(source === "qq" ? { albumMid: "000MkMni19ClKG" } : {}),
      cover: "",
      duration: 200000 + id * 1000,
      fee: 0,
      quality: "lossless",
      ...extra,
    });
    const artist = (source: string) => ({
      source,
      ...jay(source),
      mid: source === "qq" ? "0025NhlN2yWrP4" : "",
      avatar: "",
      albumCount: 3,
      songCount: 40,
      alias: "Jay Chou",
    });
    const album = (source: string, i: number) => ({
      source,
      id: 18905 + i,
      mid: source === "qq" ? "alb" + i : "",
      name: i ? `专辑 ${i}` : "叶惠美",
      artist: "周杰伦",
      artistId: jay(source).id,
      artistMid: source === "qq" ? "0025NhlN2yWrP4" : "",
      cover: "",
      publishTime: 1059609600000,
      trackCount: 3,
    });
    const tracks = (source: string) => [
      song(source, 1, "以父之名"),
      song(source, 2, "晴天"),
      song(source, 3, "东风破"),
    ];
    w.__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args: any = {}) => {
        const source = cmd === "qq_request" ? "qq" : "netease";
        const op = source === "qq" ? args.operation : cmd;
        const a = source === "qq" ? args.args : args;
        w.__calls.push({ source, op, args: a });
        if (op === "account_status") return null;
        if (op === "search_songs")
          return {
            songs:
              source === "qq"
                ? [
                    song("qq", 2, "晴天"),
                    song("qq", 9, "稻香", { quality: "hires" }),
                  ]
                : tracks("netease"),
            total: source === "qq" ? 2 : 3,
          };
        if (op === "catalog_search") {
          const kind = a.kind;
          return {
            artists: kind === "artist" ? [artist(source)] : [],
            albums:
              kind === "album" ? [album(source, 0), album(source, 1)] : [],
            playlists:
              kind === "playlist"
                ? [
                    {
                      id: 700,
                      name: "周杰伦精选",
                      cover: "",
                      trackCount: 3,
                      creator: "乐迷",
                      owned: false,
                    },
                  ]
                : [],
            total: 2,
          };
        }
        if (op === "artist_detail")
          return {
            artist: artist(source),
            brief: "华语流行乐男歌手。".repeat(20),
            songs: tracks(source),
            similar: [
              {
                ...artist(source),
                id: 1,
                mid: "sim",
                name: "林俊杰",
                alias: "",
              },
            ],
          };
        if (op === "artist_albums")
          return {
            albums: [album(source, 0), album(source, 1), album(source, 2)],
            total: 3,
            more: false,
          };
        if (op === "album_detail")
          return {
            album: album(source, 0),
            description: "第四张专辑。",
            songs: tracks(source),
          };
        if (op === "playlist_tracks") {
          const all = Array.from({ length: 250 }, (_, i) =>
            song(source, 100 + i, `歌单歌曲 ${i}`, {
              duration: (i % 7) * 1000 + 1000,
            }),
          );
          const offset = a.offset || 0;
          const page = all.slice(offset, offset + 100);
          return {
            songs: page,
            total: all.length,
            nextOffset: offset + page.length,
          };
        }
        if (op === "lyric" || op === "song_lyric") return "";
        if (op === "song_url")
          return {
            url: "",
            trial: false,
            trialStart: 0,
            bitrate: 0,
            level: "standard",
            format: "",
          };
        if (op === "my_playlists") return { playlists: [], more: false };
        return null;
      },
    };
  });
  if (options.mobile)
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "userAgent", {
        value:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
      });
    });
  await page.goto("/");
}
const calls = (page: Page, op: string) =>
  page.evaluate(
    (name) => (window as any).__calls.filter((c: any) => c.op === name),
    op,
  );

test("an artist's name leads to the artist page, then an album, and back again", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 760 });
  await setup(page);
  await page.locator("#search").fill("周杰伦");
  await page.locator("#search").press("Enter");
  await expect(page.locator("#best-match")).toContainText("最佳匹配 · 歌手");
  await expect(page.locator(".song-row mark").first()).toHaveText("周杰伦");
  await expect(
    page.locator('[data-song="netease:2"] .quality-badge'),
  ).toHaveText("无损");

  await page.locator("#best-match").click();
  await expect(page.locator("#section-title")).toContainText("周杰伦");
  await expect(page.locator(".artist-hero")).toContainText("Jay Chou");
  await expect(page.locator(".song-row")).toHaveCount(3);
  await expect(page.locator("#back-button")).toHaveAttribute(
    "aria-label",
    "返回搜索",
  );
  await expect(page.locator('nav [data-view="discover"]')).toHaveClass(
    /active/,
  );
  expect((await calls(page, "artist_detail"))[0].args).toMatchObject({
    id: 6452,
  });

  await page.locator('[data-artist-tab="albums"]').click();
  await expect(page.locator(".album-card")).toHaveCount(3);
  await page.locator(".album-card").first().click();
  await expect(page.locator(".album-hero")).toContainText("叶惠美");
  await expect(page.locator(".album-hero")).toContainText("2003-07-31");
  await expect(page.locator("#back-button")).toHaveAttribute(
    "aria-label",
    "返回歌手 周杰伦",
  );

  // Back to the artist exactly as left: albums tab, no refetch.
  await page.locator("#back-button").click();
  await expect(page.locator(".album-card")).toHaveCount(3);
  expect(await calls(page, "artist_detail")).toHaveLength(1);
  await page.keyboard.press("Escape");
  await expect(page.locator("#section-title")).toContainText("搜索结果");
  await expect(page.locator("#back-button")).toBeHidden();
  await expect(page.locator(".song-row")).toHaveCount(3);
});

test("artist and album names inside a row open their pages without playing", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 760 });
  await setup(page);
  await expect(page.locator(".song-row")).toHaveCount(3);
  const row = page.locator('[data-song="netease:1"]');
  await row.locator("[data-artist-link]").dblclick();
  await expect(page.locator("#section-title")).toContainText("周杰伦");
  await expect(page.locator("#now-name")).not.toHaveText("以父之名");
  await page.locator("#back-button").click();
  await page.locator('[data-song="netease:1"] [data-album-link]').click();
  await expect(page.locator(".album-hero")).toContainText("叶惠美");
  // Playing from the album, the player's own artist credit is a link too.
  await page.locator('[data-song="netease:3"]').dblclick();
  await expect(page.locator("#now-name")).toHaveText("东风破");
  await page.locator("#now-artist [data-artist-link]").click();
  await expect(page.locator(".artist-hero")).toBeVisible();
  await expect(page.locator("#back-button")).toHaveAttribute(
    "aria-label",
    "返回专辑 叶惠美",
  );
  // The album's own artist credit leads to the same page.
  await page.locator("#back-button").click();
  await page.locator(".album-hero [data-album-artist]").click();
  await expect(page.locator(".artist-hero")).toBeVisible();
});

test("search tabs list artists, albums and public playlists; a playlist opens and returns", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 760 });
  await setup(page);
  await page.locator("#search").fill("周杰伦");
  await page.locator("#search").press("Enter");
  await page.locator('[data-search-kind="artist"]').click();
  await expect(page.locator(".artist-card")).toHaveCount(1);
  await expect(page.locator("#best-match")).toHaveCount(0);
  await page.locator('[data-search-kind="album"]').click();
  await expect(page.locator(".album-card")).toHaveCount(2);
  await page.locator('[data-search-kind="playlist"]').click();
  await expect(page.locator(".playlist-result")).toHaveCount(1);
  await page.locator(".playlist-result").click();
  await expect(page.locator("#section-title")).toContainText("周杰伦精选");
  await expect(page.locator(".song-row")).toHaveCount(100);
  await expect(page.locator("#copy-playlist")).toBeVisible();
  await page.locator("#back-button").click();
  await expect(page.locator(".playlist-result")).toHaveCount(1);
  await expect(page.locator('[data-search-kind="playlist"]')).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("searching both platforms merges the same recording once and pages each side", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 760 });
  await setup(page);
  await page.locator("#search-source").selectOption("all");
  await expect(page.locator("#search-summary")).toContainText("两个平台");
  // 3 NetEase + 2 QQ, where QQ's 晴天 is the same recording as NetEase's.
  await expect(page.locator(".song-row")).toHaveCount(4);
  await expect(page.locator('[data-song="qq:2"]')).toHaveCount(0);
  await expect(page.locator('[data-song="qq:9"] .quality-badge')).toHaveText(
    "Hi-Res",
  );
  await expect(page.locator("#more")).toBeHidden();
});

test("filtering a paged playlist loads all of it; sorting and copying keep every song", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 760 });
  await setup(page);
  await page.locator("#search").fill("周杰伦");
  await page.locator("#search").press("Enter");
  await page.locator('[data-search-kind="playlist"]').click();
  await page.locator(".playlist-result").click();
  await expect(page.locator(".song-row")).toHaveCount(100);
  await page.locator("#list-filter").fill("歌单歌曲 24");
  // Every term must match: 24, 124, 224 and 240–249 once all pages arrived.
  await expect(page.locator(".song-row")).toHaveCount(13);
  await expect(page.locator("#result-count")).toHaveText(" / 13");
  await page.locator("#list-filter").fill("");
  await page.locator("#list-sort").selectOption("long");
  await expect(page.locator(".song-row")).toHaveCount(250);
  await expect(page.locator(".song-row").first()).toContainText("0:07");
  await page.locator("#copy-playlist").click();
  await expect(page.locator("#toast")).toContainText("共 250 首");
  const stored = await page.evaluate(() => {
    const raw =
      localStorage.getItem("ting.library-sync.v1") ||
      localStorage.getItem("ting.playlists") ||
      "";
    const data = JSON.parse(raw);
    const lists = Array.isArray(data) ? data : data.playlists;
    return lists
      .filter((p: any) => p.name === "周杰伦精选")
      .map((p: any) => p.songs.length);
  });
  expect(stored).toEqual([250]);
});

test("the artist page is reopened after a restart", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 760 });
  await setup(page);
  await page.locator('[data-song="netease:1"] [data-artist-link]').click();
  await expect(page.locator(".artist-hero")).toBeVisible();
  await page.reload();
  await expect(page.locator(".artist-hero")).toContainText("周杰伦");
  await expect(page.locator("#back-button")).toBeVisible();
  await page.locator("#back-button").click();
  await expect(page.locator("#section-title")).toContainText("搜索结果");
});

test("on a phone, rows stay one tap target and the menu leads to the artist", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page, { mobile: true });
  await expect(page.locator(".song-row")).toHaveCount(3);
  await expect(page.locator(".song-row [data-artist-link]")).toHaveCount(0);
  await page.locator('[data-song-menu="netease:2"]').click();
  await page.locator('[data-browse="0"]').click();
  await expect(page.locator(".artist-hero")).toBeVisible();
  await page.locator("#back-button").click();
  await page.locator('[data-song-menu="netease:2"]').click();
  await page.locator('[data-browse="album"]').click();
  await expect(page.locator(".album-hero")).toBeVisible();
});

test("an old saved song without ids finds its artist by name on its platform", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 760 });
  await page.addInitScript(() => {
    localStorage.setItem(
      "ting.favorites",
      JSON.stringify([
        {
          id: 5,
          source: "qq",
          mid: "m5",
          name: "旧收藏",
          artist: "周杰伦",
          album: "叶惠美",
          cover: "",
          duration: 1000,
          fee: 0,
        },
      ]),
    );
  });
  await setup(page);
  await page.locator('[data-view="favorites"]').click();
  await page.locator('[data-song="qq:5"] [data-artist-link]').click();
  await expect(page.locator(".artist-hero")).toContainText("周杰伦");
  const lookups = await page.evaluate(() =>
    (window as any).__calls.filter(
      (c: any) =>
        c.source === "qq" && ["catalog_search", "artist_detail"].includes(c.op),
    ),
  );
  expect(lookups.map((c: any) => c.op)).toEqual([
    "catalog_search",
    "artist_detail",
  ]);
  expect(lookups[1].args.mid).toBe("0025NhlN2yWrP4");
});
