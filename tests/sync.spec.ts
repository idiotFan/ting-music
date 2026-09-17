import { test, expect, type Page } from "@playwright/test";
test.use({
  viewport: { width: 393, height: 852 },
  isMobile: true,
  hasTouch: true,
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile",
});
async function setup(page: Page) {
  await page.addInitScript(() => {
    const w = window as any;
    const song = {
      id: 1,
      source: "netease",
      name: "同步歌曲",
      artist: "歌手",
      album: "专辑",
      cover: "",
      duration: 10000,
      fee: 0,
    };
    const initial = {
      id: 42,
      internal: true,
      name: "原有混合歌单",
      songs: [song],
      creator: "本机",
      owned: true,
      cover: "",
      trackCount: 1,
    };
    if (!localStorage.getItem("ting.playlists"))
      localStorage.setItem("ting.playlists", JSON.stringify([initial]));
    localStorage.setItem("ting.playlist-filter", "internal");
    localStorage.setItem("private-session-fixture", "must-not-sync-this-value");
    w.__syncCalls = [];
    w.__syncBackend = JSON.parse(
      localStorage.getItem("__fakeSync") || "null",
    ) || { lists: [], applied: [], connected: false };
    const key = (s: any) => `${s.source || "netease"}:${s.id}`;
    Object.defineProperty(window, "isTauri", { value: true });
    w.__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args: any = {}) => {
        if (cmd === "search_songs") return { songs: [song], total: 1 };
        if (cmd === "sync_choose_folder") {
          if (w.__cancelPicker) return false;
          w.__syncBackend.connected = true;
          return true;
        }
        if (cmd === "sync_disconnect") {
          w.__syncBackend.connected = false;
          return null;
        }
        if (cmd !== "sync_library") return null;
        w.__syncCalls.push(structuredClone(args));
        if (w.__syncFail) throw new Error("文件夹暂不可用");
        const backend = w.__syncBackend;
        for (const batch of args.batches) {
          if (backend.applied.includes(batch.id)) continue;
          for (const c of batch.changes) {
            if (c.deleted) {
              backend.lists = backend.lists.filter((p: any) => p.id !== c.id);
              continue;
            }
            let p = backend.lists.find((p: any) => p.id === c.id);
            if (!p && c.create) {
              p = {
                id: c.id,
                internal: true,
                name: "",
                songs: [],
                creator: "本机",
                owned: true,
                cover: "",
                trackCount: 0,
              };
              backend.lists.push(p);
            }
            if (!p) throw new Error("missing playlist");
            if (c.name !== undefined) p.name = c.name;
            for (const s of c.add || [])
              if (!p.songs.some((t: any) => key(t) === key(s))) p.songs.push(s);
            p.songs = p.songs.filter(
              (s: any) => !(c.remove || []).includes(key(s)),
            );
            if (c.order)
              p.songs.sort(
                (a: any, b: any) =>
                  c.order.indexOf(key(a)) - c.order.indexOf(key(b)),
              );
            p.trackCount = p.songs.length;
          }
          backend.applied.push(batch.id);
        }
        localStorage.setItem("__fakeSync", JSON.stringify(backend));
        const response = {
          device: "00000000-0000-4000-8000-000000000001",
          playlists: structuredClone(backend.lists),
          ack: args.batches.map((b: any) => b.id),
          connected: backend.connected,
          folder: backend.connected ? "Ting" : null,
          icloud: true,
          pending: false,
          lastExchange: backend.connected ? 1800000000 : null,
        };
        if (w.__holdSync) {
          w.__holdSync = false;
          await new Promise((resolve) => (w.__releaseSync = resolve));
        }
        return response;
      },
    };
  });
  await page.goto("/");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("ting.library-sync.v1") || "{}")
            .device,
      ),
    )
    .toBe("00000000-0000-4000-8000-000000000001");
}
async function playlists(page: Page) {
  await page.locator('[data-view="playlists"]').tap();
  await page.locator('[data-playlist-filter="internal"]').tap();
}
async function create(page: Page, name: string) {
  await page.locator("#new-playlist").tap();
  await page.locator("#playlist-name").fill(name);
  await page.locator("#playlist-name-form button").tap();
  await expect(page.locator("#library-dialog")).toBeHidden();
}
test("existing playlists migrate once, share only approved metadata, and picker cancellation preserves data", async ({
  page,
}) => {
  await setup(page);
  const calls = await page.evaluate(() => (window as any).__syncCalls);
  expect(calls[0].batches[0].changes[0].name).toBe("原有混合歌单");
  expect(JSON.stringify(calls)).not.toContain("must-not-sync-this-value");
  await page.locator("#sync-button").tap();
  await page.evaluate(() => ((window as any).__cancelPicker = true));
  await page.locator("#sync-connect").tap();
  await expect(page.locator("#sync-status")).toContainText("未开启");
  await page.locator("#sync-close").tap();
  await playlists(page);
  await expect(page.locator(".playlist-card")).toContainText("原有混合歌单");
  await page.reload();
  await expect
    .poll(() => page.evaluate(() => (window as any).__syncCalls.length))
    .toBeGreaterThan(0);
  expect(
    await page.evaluate(() => (window as any).__syncCalls[0].batches),
  ).toEqual([]);
});
test("connecting, receiving a remote playlist, and disconnecting keep the local library usable", async ({
  page,
}) => {
  await setup(page);
  await page.locator("#sync-button").tap();
  await page.locator("#sync-connect").tap();
  await expect(page.locator("#sync-status")).toContainText(
    "已与同步文件夹交换",
  );
  await page.evaluate(() => {
    const b = (window as any).__syncBackend;
    b.lists[0].name = "来自 Mac 的改名";
  });
  await page.locator("#sync-now").tap();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("ting.library-sync.v1")!).playlists[0]
            .name,
      ),
    )
    .toBe("来自 Mac 的改名");
  await page.locator("#sync-disconnect").tap();
  await expect(page.locator("#sync-status")).toContainText("未开启");
  await page.locator("#sync-close").tap();
  await playlists(page);
  await expect(page.locator(".playlist-card")).toContainText("来自 Mac 的改名");
});
test("edits made during an in-flight exchange are not replaced by its stale snapshot", async ({
  page,
}) => {
  await setup(page);
  await playlists(page);
  await page.evaluate(() => {
    (window as any).__holdSync = true;
    window.dispatchEvent(new Event("online"));
  });
  await expect
    .poll(() => page.evaluate(() => typeof (window as any).__releaseSync))
    .toBe("function");
  await create(page, "同步期间新建");
  await page.evaluate(() => (window as any).__releaseSync());
  await expect(
    page.locator(".playlist-card").filter({ hasText: "同步期间新建" }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("ting.library-sync.v1")!).pending
            .length,
      ),
    )
    .toBe(0);
  expect(
    await page.evaluate(() =>
      (window as any).__syncBackend.lists.some(
        (p: any) => p.name === "同步期间新建",
      ),
    ),
  ).toBe(true);
});
test("failed native sync retains a durable outbox across reload and later recovery", async ({
  page,
}) => {
  await setup(page);
  await playlists(page);
  await page.evaluate(() => ((window as any).__syncFail = true));
  await create(page, "离线新增");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("ting.library-sync.v1")!).pending
            .length,
      ),
    )
    .toBe(1);
  await page.locator("#sync-button").tap();
  await expect(page.locator("#sync-warning")).toContainText("文件夹暂不可用");
  await page.reload();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("ting.library-sync.v1")!).pending
            .length,
      ),
    )
    .toBe(0);
  await playlists(page);
  await expect(
    page.locator(".playlist-card").filter({ hasText: "离线新增" }),
  ).toBeVisible();
});
test("sync settings fit a narrow phone and opening them does not log out either music account", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await setup(page);
  await page.locator("#sync-button").tap();
  const box = (await page.locator("#sync-dialog").boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(320);
  expect(box.y + box.height).toBeLessThanOrEqual(568);
  await expect(page.locator("#sync-connect")).toBeVisible();
  expect(
    await page.evaluate(() =>
      (window as any).__syncCalls.every((c: any) =>
        Object.keys(c).every((k) =>
          ["batches", "exchange", "expectedDevice"].includes(k),
        ),
      ),
    ),
  ).toBe(true);
});
