import { test, expect, type Page } from "@playwright/test";

async function setup(page: Page, version: string | null) {
  await page.addInitScript((staged) => {
    const w = window as any;
    Object.defineProperty(window, "isTauri", { value: true });
    w.__updateCalls = [];
    w.__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        if (cmd === "update_ready") {
          // The backend answers only after the silent download has settled.
          await new Promise((resolve) => setTimeout(resolve, 150));
          return staged;
        }
        if (cmd === "update_install") {
          w.__updateCalls.push(cmd);
          await new Promise((resolve) => setTimeout(resolve, 150));
          if (w.__updateFails)
            throw "更新安装失败，请确认应用所在位置可写，或手动下载新版本";
          return null;
        }
        if (cmd === "search_songs") return { songs: [], total: 0 };
        return null;
      },
    };
  }, version);
  await page.goto("/");
}

test("a staged update offers a manual restart without interrupting the player", async ({
  page,
}) => {
  await setup(page, "0.9.8");
  const notice = page.locator("#update-notice");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("新版本 0.9.8 已下载");
  // Nothing is installed until the listener asks for it.
  expect(await page.evaluate(() => (window as any).__updateCalls)).toEqual([]);
  const box = (await notice.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  await page.locator("#update-restart").click();
  await expect(page.locator("#update-restart")).toBeDisabled();
  await expect(page.locator("#update-restart")).toHaveText("正在安装…");
  await expect(page.locator("#update-later")).toBeDisabled();
  expect(await page.evaluate(() => (window as any).__updateCalls)).toEqual([
    "update_install",
  ]);
});

test("a failed install explains itself and can be retried", async ({
  page,
}) => {
  await setup(page, "0.9.8");
  await page.evaluate(() => ((window as any).__updateFails = true));
  await page.locator("#update-restart").click();
  await expect(page.locator("#toast")).toContainText("更新安装失败");
  await expect(page.locator("#update-restart")).toBeEnabled();
  await expect(page.locator("#update-restart")).toHaveText("重启更新");
  await page.evaluate(() => ((window as any).__updateFails = false));
  await page.locator("#update-restart").click();
  await expect
    .poll(() => page.evaluate(() => (window as any).__updateCalls.length))
    .toBe(2);
});

test("postponing removes the notice, and no update means no notice", async ({
  page,
}) => {
  await setup(page, "0.9.8");
  await page.locator("#update-later").click();
  await expect(page.locator("#update-notice")).toHaveCount(0);
  await expect(page.locator("#toast")).toContainText("下次启动");
  await setup(page, null);
  await page.waitForTimeout(400);
  await expect(page.locator("#update-notice")).toHaveCount(0);
});
