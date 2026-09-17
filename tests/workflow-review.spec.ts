import { test, expect, type Page } from "@playwright/test";

const phone = {
  viewport: { width: 393, height: 852 },
  isMobile: true,
  hasTouch: true,
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile",
};

async function setup(page: Page) {
  await page.addInitScript(() => {
    const w = window as any;
    Object.defineProperty(window, "isTauri", { value: true });
    w.__workflowCalls = [];
    const songs = Array.from({ length: 60 }, (_, i) => ({
      id: i + 1,
      name: `流程歌曲 ${i + 1}`,
      artist: "测试歌手",
      album: "测试专辑",
      cover: "",
      duration: 20000,
      fee: 0,
    }));
    localStorage.setItem("ting.favorites", JSON.stringify(songs));
    localStorage.setItem("ting.playlist-filter", "netease");
    w.__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args: any = {}) => {
        const operation = cmd === "qq_request" ? args.operation : cmd;
        const source = cmd === "qq_request" ? "qq" : "netease";
        w.__workflowCalls.push({ operation, source });
        if (operation === "account_status")
          return {
            userId: source === "qq" ? 456 : 123,
            nickname: source === "qq" ? "QQ测试账号" : "网易云测试账号",
            avatar: "",
          };
        if (operation === "search_songs") return { songs, total: songs.length };
        if (operation === "my_playlists")
          return {
            playlists: Array.from({ length: 24 }, (_, i) => ({
              id: i + 100,
              name: `流程歌单 ${i + 1}`,
              cover: "",
              trackCount: songs.length,
              creator: "测试账号",
              owned: true,
            })),
            more: false,
          };
        if (operation === "playlist_tracks")
          return { songs, total: songs.length, nextOffset: songs.length };
        if (operation === "logout")
          await new Promise<void>((resolve) => {
            w.__finishWorkflowLogout = resolve;
          });
        return null;
      },
    };
  });
  await page.goto("/");
  await expect(page.locator(".song-row")).toHaveCount(60);
  await expect(page.locator("#account-name")).toHaveText("双账号");
}

const scrollTop = (page: Page) =>
  page.locator(".main-scroll").evaluate((el) => el.scrollTop);

test("mobile home logo is a stable 44px touch target when already home", async ({
  browser,
}) => {
  const context = await browser.newContext(phone);
  const page = await context.newPage();
  await setup(page);
  const brand = page.locator(".brand");
  const box = await brand.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeGreaterThanOrEqual(44);
  expect(
    await brand.evaluate((el) => getComputedStyle(el).webkitTapHighlightColor),
  ).toBe("rgba(0, 0, 0, 0)");
  await page.locator(".main-scroll").evaluate((el) => (el.scrollTop = 800));
  await page.evaluate(() => {
    const w = window as any;
    w.__workflowBeforeCalls = w.__workflowCalls.length;
    w.__workflowFirstRow = document.querySelector(".song-row");
    w.__workflowDomChanges = 0;
    w.__workflowObserver = new MutationObserver((changes) => {
      w.__workflowDomChanges += changes.length;
    });
    w.__workflowObserver.observe(document.querySelector(".library"), {
      childList: true,
      subtree: true,
      attributes: true,
    });
  });
  for (let i = 0; i < 3; i++) await brand.tap();
  expect(await scrollTop(page)).toBe(800);
  const state = await page.evaluate(() => {
    const w = window as any;
    w.__workflowObserver.disconnect();
    return {
      changes: w.__workflowDomChanges,
      requests: w.__workflowCalls.length - w.__workflowBeforeCalls,
      sameFirstRow:
        w.__workflowFirstRow === document.querySelector(".song-row"),
      selectedText: window.getSelection()?.toString(),
    };
  });
  expect(state).toEqual({
    changes: 0,
    requests: 0,
    sameFirstRow: true,
    selectedText: "",
  });
  await context.close();
});

test("navigation restores each list position and newly opened playlists start at the top", async ({
  browser,
}) => {
  const context = await browser.newContext(phone);
  const page = await context.newPage();
  await setup(page);
  await page.locator(".main-scroll").evaluate((el) => (el.scrollTop = 640));
  await page.locator('[data-view="favorites"]').tap();
  await expect.poll(() => scrollTop(page)).toBe(0);
  await page.locator(".main-scroll").evaluate((el) => (el.scrollTop = 320));
  await page.locator(".brand").tap();
  await expect.poll(() => scrollTop(page)).toBe(640);
  await page.locator('[data-view="favorites"]').tap();
  await expect.poll(() => scrollTop(page)).toBe(320);
  await page.locator('[data-view="playlists"]').tap();
  await expect(page.locator(".playlist-card")).toHaveCount(24);
  await expect.poll(() => scrollTop(page)).toBe(0);
  const playlist = page.locator('[data-playlist="netease:114"]');
  await playlist.scrollIntoViewIfNeeded();
  expect(await scrollTop(page)).toBeGreaterThan(0);
  await playlist.tap();
  await expect(page.locator("#section-title")).toContainText("流程歌单 15");
  await expect(page.locator(".song-row")).toHaveCount(60);
  await expect.poll(() => scrollTop(page)).toBe(0);
  await page.locator(".main-scroll").evaluate((el) => (el.scrollTop = 480));
  await page.locator('[data-view="playlists"]').tap();
  await expect(page.locator(".playlist-card")).toHaveCount(24);
  await page.locator('[data-playlist="netease:115"]').tap();
  await expect(page.locator("#section-title")).toContainText("流程歌单 16");
  await expect(page.locator(".song-row")).toHaveCount(60);
  await expect.poll(() => scrollTop(page)).toBe(0);
  await context.close();
});

test("a pending logout cannot dismiss or overwrite another platform account screen", async ({
  browser,
}) => {
  const context = await browser.newContext(phone);
  const page = await context.newPage();
  await setup(page);
  await page.locator("#account-button").tap();
  await expect(page.locator(".account-profile")).toContainText(
    "网易云测试账号",
  );
  await page.locator("#logout").tap();
  await expect
    .poll(() =>
      page.evaluate(
        () => typeof (window as any).__finishWorkflowLogout === "function",
      ),
    )
    .toBe(true);
  const switchButton = page.locator("#account-qq");
  if (await switchButton.isEnabled()) {
    await switchButton.tap();
    await expect(page.locator(".account-profile")).toContainText("QQ测试账号");
    await page.evaluate(() => (window as any).__finishWorkflowLogout());
    await expect(page.locator("#account-netease")).toContainText("未登录");
    await expect(page.locator("#account-dialog")).toBeVisible();
    await expect(page.locator(".account-profile")).toContainText("QQ测试账号");
    await expect(page.locator("#account-dialog")).toHaveAttribute(
      "data-provider",
      "qq",
    );
  } else {
    // Serializing account mutations is also valid, provided switching is explicit.
    await expect(switchButton).toBeDisabled();
    await page.evaluate(() => (window as any).__finishWorkflowLogout());
    await expect(page.locator("#account-dialog")).toBeHidden();
    await page.locator("#account-button").tap();
    await page.locator("#account-qq").tap();
    await expect(page.locator(".account-profile")).toContainText("QQ测试账号");
  }
  expect(
    await page.evaluate(
      () =>
        (window as any).__workflowCalls.filter(
          (call: any) => call.operation === "logout" && call.source === "qq",
        ).length,
    ),
  ).toBe(0);
  await context.close();
});

test("an internal playlist does not make an interrupted cloud library load look complete", async ({
  browser,
}) => {
  const context = await browser.newContext(phone);
  const page = await context.newPage();
  await page.addInitScript(() => {
    localStorage.setItem(
      "ting.playlists",
      JSON.stringify([
        {
          internal: true,
          id: 900,
          name: "已有本机歌单",
          creator: "本机",
          cover: "",
          owned: true,
          songs: [],
        },
      ]),
    );
  });
  await setup(page);
  await page.evaluate(() => {
    const w = window as any;
    const original = w.__TAURI_INTERNALS__.invoke;
    const heldSources = new Set<string>();
    w.__workflowHeldPages = [];
    w.__workflowStalePagesReturned = 0;
    w.__TAURI_INTERNALS__.invoke = async (cmd: string, args: any = {}) => {
      const operation = cmd === "qq_request" ? args.operation : cmd;
      const source = cmd === "qq_request" ? "qq" : "netease";
      if (operation === "my_playlists" && !heldSources.has(source)) {
        heldSources.add(source);
        await new Promise<void>((resolve) => {
          w.__workflowHeldPages.push(resolve);
        });
        w.__workflowStalePagesReturned++;
        return {
          playlists: [
            {
              id: 999,
              name: "已过期的云端结果",
              cover: "",
              trackCount: 0,
              creator: "测试账号",
              owned: true,
            },
          ],
          more: false,
        };
      }
      return original(cmd, args);
    };
  });
  await page.locator('[data-view="playlists"]').tap();
  await expect
    .poll(() => page.evaluate(() => (window as any).__workflowHeldPages.length))
    .toBe(2);
  await page.locator('[data-view="discover"]').tap();
  await page.locator('[data-view="playlists"]').tap();
  await expect(page.locator(".playlist-card")).toHaveCount(24);
  await page.locator('[data-playlist-filter="qq"]').tap();
  await expect(page.locator(".playlist-card")).toHaveCount(24);
  await page.locator('[data-playlist-filter="internal"]').tap();
  await expect(page.locator(".playlist-card")).toHaveCount(1);
  await expect(page.locator(".playlist-card")).toContainText("已有本机歌单");
  await page.evaluate(() => {
    (window as any).__workflowHeldPages.forEach((resolve: () => void) =>
      resolve(),
    );
  });
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__workflowStalePagesReturned),
    )
    .toBe(2);
  await page.locator('[data-playlist-filter="netease"]').tap();
  await expect(page.locator(".playlist-card")).toHaveCount(24);
  await expect(page.locator("#playlist-grid")).not.toContainText(
    "已过期的云端结果",
  );
  await context.close();
});

test("returning to an account while its logout is pending cannot preserve stale profile details", async ({
  browser,
}) => {
  const context = await browser.newContext(phone);
  const page = await context.newPage();
  await setup(page);
  await page.locator("#account-button").tap();
  await expect(page.locator(".account-profile")).toContainText(
    "网易云测试账号",
  );
  await page.locator("#logout").tap();
  await expect
    .poll(() =>
      page.evaluate(
        () => typeof (window as any).__finishWorkflowLogout === "function",
      ),
    )
    .toBe(true);
  await page.locator("#account-qq").tap();
  await expect(page.locator(".account-profile")).toContainText("QQ测试账号");
  await page.locator("#account-netease").tap();
  await expect(page.locator(".account-profile")).toContainText(
    "网易云测试账号",
  );
  await page.evaluate(() => (window as any).__finishWorkflowLogout());
  await expect(page.locator("#account-netease")).toContainText("未登录");
  await expect(page.locator("#account-dialog")).toBeVisible();
  await expect(page.locator(".account-profile")).toHaveCount(0);
  await expect(page.locator("#phone-login-form")).toBeVisible();
  await expect(page.locator("#logout")).toBeHidden();
  await page.locator("#account-qq").tap();
  await expect(page.locator(".account-profile")).toContainText("QQ测试账号");
  await context.close();
});
