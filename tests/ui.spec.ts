import { test, expect } from "@playwright/test";
import { writeFileSync, mkdirSync } from "node:fs";
const songs = [
  {
    id: 100,
    name: "测试曲目 A",
    artist: "测试歌手",
    album: "测试专辑",
    cover: "",
    duration: 120000,
    fee: 0,
  },
  {
    id: 101,
    name: "测试曲目 B",
    artist: "第二位歌手",
    album: "另一张专辑",
    cover: "",
    duration: 180000,
    fee: 1,
  },
];
test("search, favorite persistence, queue deduplication, keyboard and search race", async ({
  page,
}) => {
  await page.addInitScript(
    ({ songs }) => {
      (window as any).__TAURI_INTERNALS__ = {
        invoke: async (cmd: string, args: any) => {
          if (cmd === "search_songs") {
            if (args.query === "slow")
              await new Promise((r) => setTimeout(r, 500));
            return {
              songs: songs.map((s: any) => ({
                ...s,
                name: args.query === "fast" ? "最新结果" : s.name,
              })),
              total: 2,
            };
          }
          if (cmd === "song_url") throw "游客暂不可播放这首歌";
          if (cmd === "song_lyric") return "";
        },
      };
      Object.defineProperty(window, "isTauri", { value: true });
    },
    { songs },
  );
  await page.goto("/");
  await expect(page.locator(".song-row")).toHaveCount(2);
  await page
    .getByRole("button", { name: "收藏 测试曲目 A", exact: true })
    .click();
  await page
    .getByRole("button", { name: "加入队列 测试曲目 A", exact: true })
    .click();
  await page
    .getByRole("button", { name: "加入队列 测试曲目 A", exact: true })
    .click();
  await expect(page.locator("#queue-count")).toHaveText("1");
  await page.reload();
  await expect(page.locator("#fav-count")).toHaveText("1");
  await page.locator("[data-view=favorites]").click();
  await expect(page.locator(".song-row")).toHaveCount(1);
  await page.locator(".song-row").dblclick();
  await expect(page.locator("#track-tag")).toHaveText("播放未成功");
  await expect(page.locator("#toast")).toContainText("游客暂不可");
  await page.locator("[data-view=discover]").click();
  await page.locator("#search").fill("slow");
  await page.locator("#search").press("Enter");
  await page.locator("#search").fill("fast");
  await page.locator("#search").press("Enter");
  await expect(page.locator(".song-row").first()).toContainText("最新结果");
  await page.waitForTimeout(650);
  await expect(page.locator(".song-row").first()).toContainText("最新结果");
  await page.screenshot({ path: "work/ui-search.png" });
});
test("local audio plays offline, seeks, pauses, skips and ends without errors", async ({
  page,
  context,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.locator("#error")).toContainText("Ting 应用");
  await context.setOffline(true);
  const rate = 22050,
    seconds = 8;
  const wav = Buffer.alloc(44 + rate * seconds * 2);
  wav.write("RIFF");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(wav.length - 44, 40);
  // Silent fixture avoids playing unwanted sound while exercising the actual media pipeline.
  await page.locator("#file-input").setInputFiles([
    { name: "离线测试 A.wav", mimeType: "audio/wav", buffer: wav },
    { name: "离线测试 B.wav", mimeType: "audio/wav", buffer: wav },
  ]);
  await expect(page.locator(".song-row")).toHaveCount(2);
  await page.locator(".song-row").first().dblclick();
  await expect(page.locator("#toggle")).toHaveAttribute("aria-label", "暂停");
  await expect(page.locator("#duration")).toHaveText("0:08");
  await page.locator("#seek").fill("4");
  await expect(page.locator("#elapsed")).toHaveText("0:04");
  await page.locator("#toggle").click();
  await expect(page.locator("#toggle")).toHaveAttribute("aria-label", "播放");
  await page.locator("#next").click();
  await expect(page.locator("#now-name")).toHaveText("离线测试 B");
  await page.locator("#seek").fill("7.8");
  await expect(page.locator("#toggle")).toHaveAttribute("aria-label", "播放", {
    timeout: 5000,
  });
  expect(errors).toEqual([]);
  await page.screenshot({ path: "work/ui-local.png" });
});
