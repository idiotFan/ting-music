import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import jsQR from "jsqr";

for (const os of ["iPhone", "Android"]) {
  test(`${os} fields stay at readable scale and pinch leaves the viewport unchanged`, async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 393, height: 852 },
      isMobile: true,
      hasTouch: true,
      userAgent:
        os === "iPhone"
          ? phoneUA
          : "Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Mobile",
    });
    const page = await context.newPage();
    await mobileFixture(page, false);
    // Check the computed cascade: the old generic 16px rule lost to #search.
    await expect(page.locator("#search")).toHaveCSS("font-size", "16px");
    await page.locator("#search").tap();
    await expect(page.locator("#search")).toBeFocused();
    await page.locator("#search").press("Enter");
    const cdp = await context.newCDPSession(page);
    await cdp.send("Input.synthesizePinchGesture", {
      x: 190,
      y: 350,
      scaleFactor: 2,
      gestureSourceType: "touch",
    });
    expect(await page.evaluate(() => visualViewport!.scale)).toBe(1);
    await page.locator('[data-view="playlists"]').tap();
    await page.locator("#new-playlist").tap();
    await expect(page.locator("#playlist-name")).toHaveCSS("font-size", "16px");
    await page.locator("#playlist-name").fill("字号检查");
    await page.locator("#library-close").tap();
    await page.locator("#account-button").tap();
    const fields = page.locator('#account-dialog input:not([type="hidden"])');
    expect(await fields.count()).toBeGreaterThan(0);
    for (const field of await fields.all())
      await expect(field).toHaveCSS("font-size", "16px");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(393);
    await context.close();
  });
}

test("desktop zoom gestures are blocked while scrolling and editing shortcuts remain available", async ({
  page,
}) => {
  await mobileFixture(page);
  const result = await page.evaluate(() => {
    const send = (event: Event) => {
      document.dispatchEvent(event);
      return event.defaultPrevented;
    };
    return {
      pinch: send(new Event("gesturestart", { cancelable: true })),
      magnify: send(new Event("gesturechange", { cancelable: true })),
      wheelZoom: send(
        new WheelEvent("wheel", {
          ctrlKey: true,
          deltaY: -100,
          cancelable: true,
        }),
      ),
      scroll: send(new WheelEvent("wheel", { deltaY: 100, cancelable: true })),
      zoomKey: send(
        new KeyboardEvent("keydown", {
          key: "+",
          ctrlKey: true,
          cancelable: true,
        }),
      ),
      selectAll: send(
        new KeyboardEvent("keydown", {
          key: "a",
          metaKey: true,
          cancelable: true,
        }),
      ),
      typing: send(
        new KeyboardEvent("keydown", { key: "=", cancelable: true }),
      ),
    };
  });
  expect(result).toEqual({
    pinch: true,
    magnify: true,
    wheelZoom: true,
    scroll: false,
    zoomKey: true,
    selectAll: false,
    typing: false,
  });
  await page.locator("#search").fill("ChiliChill");
  await expect(page.locator("#search")).toHaveValue("ChiliChill");
});

test("iPhone layout keeps controls in viewport and lyrics use a dismissible full screen sheet", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 393, height: 852 },
    isMobile: true,
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile",
  });
  const page = await context.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(window, "isTauri", { value: true });
    (window as any).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        if (cmd === "search_songs") return { songs: [], total: 0 };
        return null;
      },
    };
  });
  await page.goto("/");
  await expect(page.locator("html")).toHaveClass(/mobile-device/);
  await expect(page.locator("html")).not.toHaveClass(/mac-window/);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(393);
  await expect(page.locator("#quality")).toBeVisible();
  await page.locator("#lyrics-toggle").tap();
  const panel = page.locator("#lyrics-panel");
  await expect(panel).toBeVisible();
  const box = await panel.boundingBox();
  expect(box?.x).toBe(0);
  expect(box?.width).toBe(393);
  await page.locator("#lyrics-close").tap();
  await expect(panel).toBeHidden();
  await page.screenshot({ path: "work/ios-layout.png" });
  await context.close();
});

test("Mac title is centered and clears native traffic lights and account controls", async ({
  page,
}) => {
  await page.setViewportSize({ width: 400, height: 720 });
  await page.addInitScript(() => {
    Object.defineProperty(window, "isTauri", { value: true });
    Object.defineProperty(navigator, "platform", { value: "MacIntel" });
    Object.defineProperty(navigator, "maxTouchPoints", { value: 0 });
    (window as any).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) =>
        cmd === "search_songs" ? { songs: [], total: 0 } : null,
    };
  });
  await page.goto("/");
  const brand = await page.locator(".brand").boundingBox();
  const theme = await page.locator("#theme-button").boundingBox();
  expect(Math.abs(brand!.x + brand!.width / 2 - 200)).toBeLessThan(1);
  expect(brand!.x).toBeGreaterThan(88);
  expect(brand!.x + brand!.width).toBeLessThan(theme!.x);
  await expect(page.locator(".brand-mark")).toBeHidden();
  await page.screenshot({ path: "work/mac-titlebar-layout.png" });
});

const phoneUA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile";
async function mobileFixture(
  page: import("@playwright/test").Page,
  loggedIn = false,
) {
  await page.addInitScript(
    ({ loggedIn, qrImage }) => {
      const w = window as any;
      w.__calls = [];
      Object.defineProperty(window, "isTauri", { value: true });
      const songs = [1, 2, 3].map((id) => ({
        id,
        name: `触控歌曲 ${id}`,
        artist: "测试歌手",
        album: "测试专辑",
        cover: "",
        duration: 20000,
        fee: 0,
      }));
      const wav = new ArrayBuffer(44 + 22050 * 20 * 2),
        d = new DataView(wav);
      const str = (o: number, s: string) =>
        [...s].forEach((c, i) => d.setUint8(o + i, c.charCodeAt(0)));
      str(0, "RIFF");
      d.setUint32(4, wav.byteLength - 8, true);
      str(8, "WAVEfmt ");
      d.setUint32(16, 16, true);
      d.setUint16(20, 1, true);
      d.setUint16(22, 1, true);
      d.setUint32(24, 22050, true);
      d.setUint32(28, 44100, true);
      d.setUint16(32, 2, true);
      d.setUint16(34, 16, true);
      str(36, "data");
      d.setUint32(40, wav.byteLength - 44, true);
      const url = URL.createObjectURL(new Blob([wav], { type: "audio/wav" }));
      w.__TAURI_INTERNALS__ = {
        invoke: async (cmd: string, args: any) => {
          w.__calls.push(cmd);
          if (cmd === "share_login_qr") w.__sharedQr = args.dataUrl;
          const op = cmd === "qq_request" ? args.operation : cmd;
          if (op === "account_status")
            return loggedIn
              ? { userId: 123, nickname: "测试账号", avatar: "" }
              : null;
          if (op === "search_songs") return { songs, total: songs.length };
          if (op === "song_url") {
            await new Promise((resolve) => setTimeout(resolve, 100));
            return {
              url,
              level: "standard",
              requestedLevel: "standard",
              trial: false,
              format: "wav",
              bitrate: 128000,
            };
          }
          if (op === "song_lyric") return "[00:00.00]测试歌词";
          if (op === "login_qr_start")
            return {
              key: "qa-only-key",
              url: "https://music.163.com/login?codekey=qa-only-key",
              image: qrImage,
            };
          if (op === "login_qr_check") return { code: 801 };
          if (cmd === "download_song")
            return {
              path: "/qa/Ting/test.mp3",
              filename: "test.mp3",
              source: "netease",
              level: "standard",
              format: "mp3",
              bitrate: 128000,
              sampleRate: 44100,
              bitDepth: 0,
              warnings: [],
            };
          return null;
        },
      };
    },
    {
      loggedIn,
      qrImage:
        "data:image/jpeg;base64," +
        readFileSync("tests/fixtures/wechat-login-470.jpg").toString("base64"),
    },
  );
  await page.goto("/");
  await expect(page.locator(".song-row")).toHaveCount(3);
}

test("phone taps play once, row actions stay independent, download and lyrics use mobile behavior", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 393, height: 852 },
    isMobile: true,
    hasTouch: true,
    userAgent: phoneUA,
  });
  const page = await context.newPage();
  await mobileFixture(page);
  const calls = () =>
    page.evaluate(
      () =>
        (window as any).__calls.filter((cmd: string) => cmd === "song_url")
          .length,
    );
  await page.locator("[data-enqueue]").first().tap();
  await page.locator("[data-favorite]").first().tap();
  expect(await calls()).toBe(0);
  await page.locator("[data-song-menu]").first().tap();
  await expect(page.locator("#library-dialog")).toBeVisible();
  expect(await calls()).toBe(0);
  await page.locator("#library-close").tap();
  await page.locator(".song-title").first().tap();
  await page.locator(".song-title").first().tap();
  await expect(page.locator("#toggle")).toHaveAttribute("aria-label", "暂停");
  expect(await calls()).toBe(1);
  await page.locator("#toggle").tap();
  await page.locator(".song-title").first().tap();
  await expect(page.locator("#toggle")).toHaveAttribute("aria-label", "暂停");
  expect(await calls()).toBe(1);
  await page.locator(".song-title").nth(1).tap();
  await expect(page.locator("#now-name")).toHaveText("触控歌曲 2");
  await expect.poll(calls).toBe(2);
  await page.locator("#lyrics-toggle").tap();
  await expect(page.locator("#lyrics-panel")).toBeVisible();
  await page.locator("#lyrics-close").tap();
  await page.locator("#download-current").tap();
  await expect(page.locator("#download-status")).toContainText("已保存");
  await page.locator("#download-folder").tap();
  await expect(page.locator("#toast")).toContainText("文件 App");
  const nativeCalls = await page.evaluate(() => (window as any).__calls);
  expect(nativeCalls).not.toContain("open_download_folder");
  expect(nativeCalls).not.toContain("set_lyrics_panel");
  await page.locator("#search").fill("测试");
  await page.locator("#search").press("Enter");
  await expect(page.locator("#search")).not.toBeFocused();
  await page.screenshot({ path: "work/ios-touch-layout.png" });
  await context.close();
});

for (const device of [
  { name: "iPhone", ua: phoneUA, width: 393, notice: "iOS 钥匙串" },
  {
    name: "Android",
    ua: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Mobile",
    width: 360,
    notice: "Android Keystore",
  },
  {
    name: "iPad desktop UA",
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15",
    width: 820,
    notice: "iOS 钥匙串",
  },
  { name: "small iPhone", ua: phoneUA, width: 320, notice: "iOS 钥匙串" },
]) {
  test(`${device.name} login wording and touch controls adapt to the device`, async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: device.width, height: 852 },
      isMobile: true,
      hasTouch: true,
      userAgent: device.ua,
    });
    const page = await context.newPage();
    if (device.name.startsWith("iPad"))
      await page.addInitScript(() => {
        Object.defineProperty(navigator, "platform", { value: "MacIntel" });
        Object.defineProperty(navigator, "maxTouchPoints", { value: 5 });
      });
    await mobileFixture(page);
    await expect(page.locator("html")).toHaveClass(/mobile-device/);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(device.width);
    for (const selector of [
      "#toggle",
      "#previous",
      "#lyrics-toggle",
      "[data-enqueue]",
      "#account-button",
      "#search-source",
    ]) {
      const box = await page.locator(selector).first().boundingBox();
      // Translation may introduce subpixel floating-point error in the rect.
      expect(Math.round(box!.height * 100) / 100).toBeGreaterThanOrEqual(44);
      expect(Math.round(box!.width * 100) / 100).toBeGreaterThanOrEqual(44);
    }
    await page.locator("#account-button").tap();
    await expect(page.locator(".account-note")).toContainText(device.notice);
    await expect(page.locator("#phone-login-form")).toBeVisible();
    await page.locator('[data-netease-method="qr"]').tap();
    await expect(page.locator(".account-subtitle")).toContainText("另一台设备");
    await expect(page.locator("#login-qr")).toBeVisible();
    await expect(page.locator("#account-dialog")).not.toContainText("macOS");
    const qr = await page.locator("#login-qr").boundingBox();
    expect(qr!.x).toBeGreaterThanOrEqual(0);
    expect(qr!.x + qr!.width).toBeLessThanOrEqual(device.width);
    await page.locator("#account-qq").tap();
    await expect(page.locator(".account-subtitle")).toContainText("手机 QQ");
    await page.locator('[data-qq-kind="wx"]').tap();
    await expect(page.locator(".account-subtitle")).toContainText("微信");
    await expect(page.locator("#login-qr")).toBeVisible();
    const screenshot = PNG.sync.read(
      await page.locator("#login-qr").screenshot(),
    );
    expect(
      jsQR(
        new Uint8ClampedArray(screenshot.data),
        screenshot.width,
        screenshot.height,
      )?.data,
    ).toBe("https://example.com/ting/test/wechat-qr?fixture=synthetic-470");
    const src = await page.locator("#login-qr").getAttribute("src");
    const output = PNG.sync.read(Buffer.from(src!.split(",")[1], "base64"));
    expect(screenshot.width).toBe(output.width);
    expect(screenshot.data.equals(output.data)).toBe(true);
    await context.close();
  });
}

test("restored iOS account describes iOS storage", async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 393, height: 852 },
    isMobile: true,
    hasTouch: true,
    userAgent: phoneUA,
  });
  const page = await context.newPage();
  await mobileFixture(page, true);
  await page.locator("#account-button").tap();
  await expect(page.locator("#account-status")).toContainText("iOS 钥匙串");
  await expect(page.locator("#account-status")).not.toContainText("Mac");
  await context.close();
});

for (const size of [
  { width: 320, height: 568 },
  { width: 393, height: 852 },
  { width: 568, height: 320 },
  { width: 852, height: 393 },
  { width: 820, height: 1180 },
]) {
  test(`mobile browsing and playback remain separate at ${size.width}×${size.height}`, async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: size,
      isMobile: true,
      hasTouch: true,
      userAgent: phoneUA,
    });
    const page = await context.newPage();
    await mobileFixture(page);
    const main = (await page.locator("main").boundingBox())!;
    const now = (await page.locator(".now-panel").boundingBox())!;
    const player = (await page.locator(".player").boundingBox())!;
    const nav = (await page.locator("nav").boundingBox())!;
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(size.width);
    expect(nav.y + nav.height).toBe(size.height);
    expect(main.height).toBeGreaterThan(200);
    if (size.width > size.height && size.height <= 500) {
      expect(main.x + main.width).toBeLessThanOrEqual(now.x);
      expect(main.x + main.width).toBeLessThanOrEqual(player.x);
    } else {
      expect(main.y + main.height).toBeLessThanOrEqual(now.y);
    }
    expect(now.y + now.height).toBeLessThanOrEqual(player.y);
    expect(player.y + player.height).toBeLessThanOrEqual(nav.y);
    for (const selector of [
      "#repeat",
      "#previous",
      "#toggle",
      "#next",
      "#lyrics-toggle",
      "#quality",
    ]) {
      const target = (await page.locator(selector).boundingBox())!;
      expect(target.width).toBeGreaterThanOrEqual(44);
      expect(target.height).toBeGreaterThanOrEqual(44);
      expect(target.x).toBeGreaterThanOrEqual(0);
      expect(target.x + target.width).toBeLessThanOrEqual(size.width);
      expect(target.y + target.height).toBeLessThanOrEqual(nav.y);
    }
    await context.close();
  });
}

test("phone search releases space for the keyboard and restores playback after submit", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 393, height: 852 },
    isMobile: true,
    hasTouch: true,
    userAgent: phoneUA,
  });
  const page = await context.newPage();
  await mobileFixture(page);
  await page.locator("#search").fill("键盘搜索");
  await page.setViewportSize({ width: 393, height: 480 });
  await expect(page.locator(".now-panel")).toBeHidden();
  await expect(page.locator(".player")).toBeHidden();
  const search = (await page.locator("#search").boundingBox())!;
  expect(search.y).toBeGreaterThanOrEqual(0);
  expect(search.y + search.height).toBeLessThan(480);
  expect(
    (await page.locator(".main-scroll").boundingBox())!.height,
  ).toBeGreaterThan(250);
  await page.locator("#search").press("Enter");
  await expect(page.locator("#search")).not.toBeFocused();
  await page.setViewportSize({ width: 393, height: 852 });
  await expect(page.locator(".now-panel")).toBeVisible();
  await expect(page.locator(".player")).toBeVisible();
  const main = (await page.locator("main").boundingBox())!;
  const now = (await page.locator(".now-panel").boundingBox())!;
  expect(main.y + main.height).toBeLessThanOrEqual(now.y);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    393,
  );
  await context.close();
});

test("mobile lyrics closing can interrupt opening and reduced motion skips transitions", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 393, height: 852 },
    isMobile: true,
    hasTouch: true,
    userAgent: phoneUA,
  });
  const page = await context.newPage();
  await mobileFixture(page);
  await page.locator("#lyrics-toggle").tap();
  await page.evaluate(() =>
    document.querySelector<HTMLButtonElement>("#lyrics-close")!.click(),
  );
  await expect(page.locator("#lyrics-panel")).toBeHidden();
  expect(
    await page.locator("#app").evaluate((el) => (el as HTMLElement).inert),
  ).toBe(false);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.locator("#lyrics-toggle").tap();
  await expect(page.locator("#lyrics-panel")).toBeVisible();
  expect(
    await page
      .locator("#lyrics-panel")
      .evaluate((el) => el.getAnimations().length),
  ).toBe(0);
  await page.locator("#lyrics-close").tap();
  await expect(page.locator("#lyrics-panel")).toBeHidden();
  await expect(page.locator("#lyrics-toggle")).toBeFocused();
  await context.close();
});

test("Android shares original QR through native IPC and opens its native downloads list", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 369, height: 812 },
    isMobile: true,
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (Linux; Android 16; Device) AppleWebKit/537.36 Mobile",
  });
  const page = await context.newPage();
  await mobileFixture(page);
  await page.evaluate(() => {
    Object.defineProperty(navigator, "canShare", { value: undefined });
    Object.defineProperty(navigator, "share", { value: undefined });
  });
  await page.locator("#account-button").tap();
  await page.locator("#account-qq").tap();
  await expect(page.locator("#login-qr")).toBeVisible();
  await page.locator("#share-login-qr").tap();
  await expect
    .poll(() => page.evaluate(() => (window as any).__sharedQr))
    .toMatch(/^data:image\/png;base64,/);
  const url = await page.evaluate(() => (window as any).__sharedQr);
  const image = PNG.sync.read(Buffer.from(url.split(",")[1], "base64"));
  expect(
    jsQR(new Uint8ClampedArray(image.data), image.width, image.height)?.data,
  ).toBe("https://example.com/ting/test/wechat-qr?fixture=synthetic-470");
  await page.locator("#account-close").tap();
  await page.locator(".song-row").first().tap();
  await page.locator("#download-current").tap();
  await expect(page.locator("#download-folder")).toHaveText("查看下载");
  await page.locator("#download-folder").tap();
  expect(await page.evaluate(() => (window as any).__calls)).toContain(
    "open_download_folder",
  );
  await context.close();
});
