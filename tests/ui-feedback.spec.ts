import { test, expect, type Page } from "@playwright/test";

async function setup(page: Page) {
  await page.addInitScript(() => {
    const songs = Array.from({ length: 3 }, (_, i) => ({
      id: i + 1,
      name: `交互歌曲 ${i + 1}`,
      artist: "测试歌手",
      album: "测试专辑",
      cover: "",
      duration: 120000,
      fee: 0,
    }));
    Object.defineProperty(window, "isTauri", { value: true });
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: {
        invoke: async (cmd: string, args: { id?: number } = {}) => {
          if (cmd === "search_songs") return { songs, total: songs.length };
          if (cmd === "local_restore") return [];
          if (cmd === "download_dir") return "/Music/Ting";
          if (cmd === "song_url") {
            if (args.id === 1)
              document.body.dataset.firstSongRequests = String(
                Number(document.body.dataset.firstSongRequests || 0) + 1,
              );
            return { url: "https://feedback.test/broken.wav" };
          }
          if (cmd === "song_lyric") return "";
          return null;
        },
      },
    });
  });
  await page.goto("/");
  await expect(page.locator(".song-row")).toHaveCount(3);
}

test("batch selection highlights only checked rows and restores single selection on exit", async ({
  page,
}) => {
  await setup(page);
  const rows = page.locator(".song-row");
  await rows.first().click();
  await expect(rows.first()).toHaveClass(/selected/);
  await page.locator("#select-mode").click();
  await expect(page.locator(".song-row.selected")).toHaveCount(0);
  await expect(rows.first().locator(".song-title")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await rows.nth(1).click();
  await rows.nth(2).click();
  await expect(page.locator(".song-row.checked")).toHaveCount(2);
  await expect(page.locator("#selection-count")).toHaveText("已选 2 首");
  await expect(rows.nth(1).locator(".song-title")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await rows.nth(1).evaluate(async (el) => {
    await Promise.allSettled(
      el
        .getAnimations({ subtree: true })
        .filter(
          (animation) =>
            animation.effect?.getComputedTiming().iterations !== Infinity,
        )
        .map((animation) => animation.finished),
    );
  });
  const selectedFill = await rows
    .nth(1)
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  await rows.nth(1).hover();
  await expect
    .poll(() =>
      rows.nth(1).evaluate((el) => getComputedStyle(el).backgroundColor),
    )
    .toBe(selectedFill);
  await page.locator('[data-sel="done"]').click();
  await expect(page.locator(".song-row.checked")).toHaveCount(0);
  await expect(rows.first()).toHaveClass(/selected/);
});

test("navigation and song titles stay transparent after clicks while keyboard focus remains visible", async ({
  page,
}) => {
  await setup(page);
  const nav = page.locator('[data-view="discover"]');
  await nav.hover();
  await nav.click();
  expect(await nav.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
    "rgba(0, 0, 0, 0)",
  );
  const title = page.locator(".song-title").first();
  await title.click();
  expect(
    await title.evaluate((el) => getComputedStyle(el).backgroundColor),
  ).toBe("rgba(0, 0, 0, 0)");
  await page.keyboard.press("Tab");
  expect(
    await page.evaluate(() => {
      const el = document.activeElement!;
      return (
        el.matches(":focus-visible") &&
        getComputedStyle(el).outlineStyle !== "none"
      );
    }),
  ).toBe(true);
});

test("touch selection has no lingering hover and retains the checked background", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 393, height: 852 },
    isMobile: true,
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await setup(page);
  await page.locator("#select-mode").tap();
  const row = page.locator(".song-row").first();
  await row.tap();
  await expect(row).toHaveClass(/checked/);
  await expect(page.locator(".song-row.selected")).toHaveCount(0);
  const colors = await page
    .locator(".song-row")
    .evaluateAll((rows) =>
      rows.map((row) => getComputedStyle(row).backgroundColor),
    );
  expect(colors[0]).not.toBe(colors[1]);
  await row.tap();
  await expect(row).not.toHaveClass(/checked/);
  expect(await row.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
    colors[1],
  );
  await context.close();
});

test("desktop settings keep their close button visible and return from theme and sound without losing scroll", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 640 });
  await setup(page);
  await page.locator("#settings-button").click();
  const dialog = page.locator("#settings-dialog");
  const close = dialog.locator("[data-settings-close]");
  expect(await close.evaluate((el) => el.matches(":focus-visible"))).toBe(
    false,
  );
  await dialog.evaluate((el) => (el.scrollTop = el.scrollHeight));
  const bounds = await dialog.boundingBox();
  const button = await close.boundingBox();
  expect(button!.y).toBeGreaterThanOrEqual(bounds!.y);
  expect(button!.y + button!.height).toBeLessThan(bounds!.y + bounds!.height);
  for (const [trigger, child, dismiss] of [
    ["[data-open-theme]", "#theme-dialog", "#theme-close"],
    ["[data-open-sound]", "#sound-dialog", "[data-sound-close]"],
  ]) {
    await dialog.locator(trigger).scrollIntoViewIfNeeded();
    const before = await dialog.evaluate((el) => el.scrollTop);
    await dialog.locator(trigger).click();
    await expect(page.locator(child)).toBeVisible();
    await expect(dialog).toBeVisible();
    await page.locator(dismiss).click();
    await expect(page.locator(child)).toBeHidden();
    expect(await dialog.evaluate((el) => el.scrollTop)).toBe(before);
    expect(
      await dialog
        .locator(trigger)
        .evaluate((el) => el === document.activeElement),
    ).toBe(true);
  }
  await close.click();
  await expect(dialog).toBeHidden();
});

test("a failed stream shows play instead of pause and play retries the source", async ({
  page,
}) => {
  await page.route("https://feedback.test/broken.wav", (route) =>
    route.abort("failed"),
  );
  await setup(page);
  await page.locator(".song-row").first().dblclick();
  await expect(page.locator("body")).toHaveAttribute("data-playback", "error");
  await expect(page.locator("#toggle")).toHaveAttribute("aria-label", "播放");
  await expect(page.locator("body")).not.toHaveClass(/playing/);
  await expect(page.locator("#track-tag")).toHaveText(/失败|未成功/);
  const requests = await page
    .locator("body")
    .getAttribute("data-first-song-requests");
  await page.locator("#toggle").click();
  await expect(page.locator("body")).toHaveAttribute(
    "data-first-song-requests",
    String(Number(requests) + 1),
  );
  await expect(page.locator("#toggle")).toHaveAttribute("aria-label", "播放");
});
