import { test, expect, type Page } from "@playwright/test";

// Tiny valid colored SVG data URL for real cover palette extraction in tests.
const SAMPLE_COVER =
  "data:image/svg+xml;charset=utf-8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#1d6fa5"/><stop offset="55%" stop-color="#2c8f7a"/><stop offset="100%" stop-color="#d97a4a"/></linearGradient></defs><rect width="320" height="320" fill="url(#g)"/><circle cx="160" cy="145" r="72" fill="#f7e7ce" opacity="0.88"/><rect x="76" y="236" width="168" height="24" rx="12" fill="#183244" opacity="0.65"/></svg>`,
  );

const SAMPLE_LRC = [
  "[00:00.00]作词：测试词人",
  "[00:02.00]夜色漫过窗台的微风",
  "[00:05.00]霓虹在杯壁画出了迷宫",
  "[00:08.00]留声机转过第几圈温柔",
  "[00:11.00]此刻的旋律只为你停留",
  "[00:14.00]推开门 挥挥手 转身就走",
  "[00:17.00]把所有星光装进耳机中",
].join("\n");

function silentWav(seconds = 20) {
  const rate = 8000;
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
  return wav;
}

async function desktopFixture(page: Page) {
  await page.route("**/__stage-audio.wav", (route) =>
    route.fulfill({
      status: 200,
      contentType: "audio/wav",
      body: silentWav(24),
      headers: { "Access-Control-Allow-Origin": "*" },
    }),
  );
  await page.addInitScript(
    ({ cover, lyric }) => {
      const w = window as any;
      Object.defineProperty(window, "isTauri", { value: true });
      const songs = Array.from({ length: 48 }, (_, i) => ({
        id: i + 1,
        name: `流光曲目 ${i + 1}`,
        artist: i % 2 === 0 ? "ChiliChill" : "声音玩具",
        album: `午夜唱片集 ${Math.floor(i / 6) + 1}`,
        cover,
        duration: 214000,
        fee: 0,
      }));
      localStorage.setItem("ting.playlist-filter", "netease");
      w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
      w.__TAURI_INTERNALS__ = {
        transformCallback: () => 1,
        invoke: async (cmd: string, args: any = {}) => {
          if (cmd === "plugin:event|emit" || cmd === "plugin:event|listen")
            return 1;
          if (cmd === "account_status")
            return { userId: 7, nickname: "测试用户", avatar: "" };
          if (cmd === "search_songs") return { songs, total: songs.length };
          if (cmd === "catalog_search")
            return { artists: [], albums: [], playlists: [], total: 0 };
          if (cmd === "my_playlists")
            return {
              playlists: [
                {
                  id: 201,
                  name: "深夜黑胶漫游指南",
                  cover,
                  trackCount: songs.length,
                  creator: "测试用户",
                  owned: true,
                },
              ],
              more: false,
            };
          if (cmd === "playlist_tracks")
            return { songs, total: songs.length, nextOffset: songs.length };
          if (cmd === "song_lyric") return lyric;
          if (cmd === "song_url")
            return {
              url: "/__stage-audio.wav",
              trial: false,
              trialStart: 0,
              bitrate: 1672000,
              level: "hires",
              requestedLevel: "best",
              format: "flac",
            };
          if (cmd === "download_dir") return "/Users/me/Downloads/Ting";
          if (cmd === "diagnostics")
            return {
              version: "1.0.1",
              os: "macos",
              arch: "aarch64",
              family: "unix",
            };
          if (cmd === "local_restore") return [];
          if (cmd === "local_scan")
            return {
              folders: ["/Music/Vinyl"],
              download_folder: null,
              tracks: [],
            };
          return null;
        },
      };
    },
    { cover: SAMPLE_COVER, lyric: SAMPLE_LRC },
  );
  await page.goto("/");
  await expect(page.locator(".song-row")).toHaveCount(48);
}

test("detail back button stays pinned while scrolling deep into a playlist and supports Alt+Left", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1360, height: 820 });
  await desktopFixture(page);
  await page.locator('[data-view="playlists"]').click();
  await page.locator('[data-playlist="netease:201"]').click();
  await expect(page.locator("#section-title")).toContainText(
    "深夜黑胶漫游指南",
  );
  await expect(page.locator(".song-row")).toHaveCount(48);

  const back = page.locator("#back-button");
  const before = (await back.boundingBox())!;
  expect(before.y).toBeGreaterThanOrEqual(0);

  // Scroll all the way to the bottom of the 48-track playlist.
  await page
    .locator(".main-scroll")
    .evaluate((el) => (el.scrollTop = el.scrollHeight));
  await expect(page.locator("main")).toHaveClass(/main-scrolled/);

  // The pinned back button must remain at the exact same viewport Y!
  const after = (await back.boundingBox())!;
  expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1);
  await expect(back).toBeInViewport();
  await page.screenshot({ path: "work/verify-pinned-playlist.png" });

  // Alt+ArrowLeft navigates back cleanly from the bottom of the list.
  await page.keyboard.press("Alt+ArrowLeft");
  await expect(page.locator("#section-title")).toContainText("我的歌单");
  await expect(back).toBeHidden();
});

test("desktop dialogs expand into spacious multi-column layouts without cramped vertical scrolling", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1360, height: 820 });
  await desktopFixture(page);

  // 1. Settings workbench: wide two-column layout with sidebar navigation.
  await page.locator("#settings-button").click();
  const settings = page.locator("#settings-dialog");
  await expect(settings).toBeVisible();
  await expect
    .poll(() =>
      settings.evaluate((el) =>
        el.getAnimations().every((a) => a.playState !== "running"),
      ),
    )
    .toBe(true);
  const settingsBox = (await settings.boundingBox())!;
  expect(settingsBox.width).toBeGreaterThanOrEqual(720);
  const navBox = (await settings.locator(".settings-nav").boundingBox())!;
  const bodyBox = (await settings.locator(".settings-body").boundingBox())!;
  expect(bodyBox.x).toBeGreaterThanOrEqual(navBox.x + navBox.width - 1);
  expect(bodyBox.width).toBeGreaterThanOrEqual(500);
  await settings.locator('[data-settings-jump="desktop"]').click();
  await expect(
    settings.locator('[data-settings-jump="desktop"]'),
  ).toHaveAttribute("aria-current", "true");
  await page.screenshot({ path: "work/verify-settings-workbench.png" });
  // Clicking bottom sections ("数据" / "关于") must lock the highlight and never
  // get yanked back by scroll-spy during or after smooth scrolling.
  for (const id of ["data", "about"]) {
    await settings.locator(`[data-settings-jump="${id}"]`).click();
    await expect(
      settings.locator(`[data-settings-jump="${id}"]`),
    ).toHaveAttribute("aria-current", "true");
    await page.waitForTimeout(750);
    await expect(
      settings.locator(`[data-settings-jump="${id}"]`),
    ).toHaveAttribute("aria-current", "true");
  }
  await settings.locator("[data-settings-close]").click();
  await expect(settings).toBeHidden();

  // 2. Theme picker: wide 4-column grid + ambient toggle, fits cleanly.
  await page.locator("#theme-button").click();
  const themeDialog = page.locator("#theme-dialog");
  await expect(themeDialog).toBeVisible();
  await expect
    .poll(() =>
      themeDialog.evaluate((el) =>
        el.getAnimations().every((a) => a.playState !== "running"),
      ),
    )
    .toBe(true);
  const themeBox = (await themeDialog.boundingBox())!;
  expect(themeBox.width).toBeGreaterThanOrEqual(560);
  await expect(themeDialog.locator("#theme-ambient")).toBeChecked();
  await page.screenshot({ path: "work/verify-theme-dialog.png" });
  await themeDialog.locator("#theme-close").click();
  await expect(themeDialog).toBeHidden();

  // 3. Sound panel: wide 2-column grid with live EQ curve visualization.
  await page.locator("#sound-button").click();
  const soundDialog = page.locator("#sound-dialog");
  await expect(soundDialog).toBeVisible();
  const soundBox = (await soundDialog.boundingBox())!;
  expect(soundBox.width).toBeGreaterThanOrEqual(580);
  await expect(soundDialog.locator(".eq-curve svg")).toBeVisible();
  await soundDialog.locator('[data-eq="vocal"]').click();
  await page.screenshot({ path: "work/verify-sound-dialog.png" });
  await soundDialog.locator("[data-sound-close]").click();
  await expect(soundDialog).toBeHidden();
});

test("desktop right-click opens song menu, and vinyl & theater stage modes work cleanly", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 860 });
  await desktopFixture(page);

  // Right-click a song row opens the song action menu.
  await page.locator(".song-row").first().click({ button: "right" });
  await expect(page.locator("#library-dialog")).toBeVisible();
  await page.locator("#library-close").click();
  await expect(page.locator("#library-dialog")).toBeHidden();

  // Play track & open lyrics to verify ambient stage + Hi-Fi console + lyrics.
  await page.locator(".song-row").first().dblclick();
  await expect(page.locator("body")).toHaveAttribute(
    "data-playback",
    "playing",
  );
  await page.locator("#seek").fill("8.5");
  await page.locator("#seek").dispatchEvent("change");
  await page.locator("#lyrics-toggle").click();
  await expect(page.locator("#lyrics-panel")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-ambient", "on");
  await page.screenshot({ path: "work/verify-stage-default.png" });

  // Switch to Vinyl turntable mode (tonearm drops onto vinyl while playing).
  await page.locator("#stage-vinyl-toggle").click();
  await expect(page.locator("body")).toHaveClass(/stage-vinyl/);
  await expect(page.locator(".vinyl-arm svg")).toBeVisible();
  await page.waitForTimeout(850);
  await page.screenshot({ path: "work/verify-stage-vinyl.png" });

  // Pausing in Vinyl mode coasts smoothly and preserves rotation angle (never snaps to 0deg).
  await page.locator("#toggle").click();
  await expect(page.locator("body")).toHaveAttribute("data-playback", "paused");
  await page.waitForTimeout(300);
  const pausedState = await page.locator("#now-cover").evaluate((cover) => {
    const img = cover.querySelector("img");
    return {
      varDeg: cover.style.getPropertyValue("--vinyl-deg").trim(),
      computedRotate: img ? getComputedStyle(img).rotate : "",
    };
  });
  expect(parseFloat(pausedState.varDeg)).toBeGreaterThan(1);
  expect(parseFloat(pausedState.computedRotate)).toBeGreaterThan(1);
  await page.locator("#toggle").click();
  await expect(page.locator("body")).toHaveAttribute(
    "data-playback",
    "playing",
  );

  // Switch to Theater mode via keyboard shortcut F, then exit via Escape.
  await page.locator(".now-panel").click();
  await page.keyboard.press("f");
  await expect(page.locator("body")).toHaveClass(/stage-theater/);
  await page.screenshot({ path: "work/verify-stage-theater.png" });

  // Preview anodized dark hardware finish (graphite) in vinyl + theater stage.
  await page.locator("#theme-button").click();
  await page.locator('[data-theme-choice="graphite"]').click();
  await page.locator("#theme-close").click();
  await expect(page.locator("#theme-dialog")).toBeHidden();
  await page.screenshot({ path: "work/verify-stage-dark.png" });

  await page.keyboard.press("Escape");
  await expect(page.locator("body")).not.toHaveClass(/stage-theater/);
});

test("adversarial stress pass 1: rapid settings nav, toggles while scrolled, scale & sub-dialogs without errors", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
  });

  await page.setViewportSize({ width: 1360, height: 820 });
  await desktopFixture(page);

  await page.locator("#settings-button").click();
  const settings = page.locator("#settings-dialog");
  await expect(settings).toBeVisible();

  // Rapidly jump across all 6 categories in non-linear order.
  const sequence = [
    "playback",
    "about",
    "desktop",
    "playback",
    "data",
    "appearance",
    "about",
    "data",
  ];
  for (const id of sequence) {
    await settings.locator(`[data-settings-jump="${id}"]`).click();
    await expect(
      settings.locator(`[data-settings-jump="${id}"]`),
    ).toHaveAttribute("aria-current", "true");
  }
  await page.waitForTimeout(750);
  // Clicking "data" (second-to-last) stays highlighted even after smooth scroll settles.
  await expect(settings.locator('[data-settings-jump="data"]')).toHaveAttribute(
    "aria-current",
    "true",
  );

  // Jump to "desktop", toggle close-to-tray and global shortcuts while scrolled down,
  // and verify scroll position and active nav stay intact across re-renders.
  await settings.locator('[data-settings-jump="desktop"]').click();
  await page.waitForTimeout(450);
  const scrollBefore = await settings
    .locator(".settings-body")
    .evaluate((el) => el.scrollTop);
  expect(scrollBefore).toBeGreaterThan(80);
  await settings.locator("#settings-tray").click();
  await expect(settings.locator("#settings-tray")).toBeChecked();
  const scrollAfterTray = await settings
    .locator(".settings-body")
    .evaluate((el) => el.scrollTop);
  expect(Math.abs(scrollAfterTray - scrollBefore)).toBeLessThanOrEqual(4);
  await expect(
    settings.locator('[data-settings-jump="desktop"]'),
  ).toHaveAttribute("aria-current", "true");

  await settings.locator("#settings-shortcuts").click();
  await expect(settings.locator("#settings-shortcuts")).toBeChecked();
  await expect(settings.locator(".shortcut-list")).toBeVisible();

  // Scale change updates cleanly without double-render errors.
  await settings.locator('[data-settings-jump="appearance"]').click();
  await settings.locator('[data-scale="1.1"]').click();
  await expect(settings.locator('[data-scale="1.1"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await settings.locator('[data-scale="1"]').click();
  await expect(settings.locator('[data-scale="1"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  // Open Theme and Sound sub-dialogs from inside Settings and return cleanly.
  await settings.locator("[data-open-theme]").click();
  await expect(page.locator("#theme-dialog")).toBeVisible();
  await page.locator("#theme-close").click();
  await expect(page.locator("#theme-dialog")).toBeHidden();

  await settings.locator("[data-open-sound]").click();
  await expect(page.locator("#sound-dialog")).toBeVisible();
  await page.locator("[data-sound-close]").click();
  await expect(page.locator("#sound-dialog")).toBeHidden();

  await settings.locator("[data-settings-close]").click();
  await expect(settings).toBeHidden();
  expect(errors).toEqual([]);
});

test("adversarial stress pass 2: rapid vinyl/theater toggles, brand exit, track skip in vinyl, lyrics interaction", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
  });

  await page.setViewportSize({ width: 1440, height: 860 });
  await desktopFixture(page);

  // Start playing track 1.
  await page.locator(".song-row").first().dblclick();
  await expect(page.locator("body")).toHaveAttribute(
    "data-playback",
    "playing",
  );

  // Rapidly toggle Vinyl/Square 6 times, ending in Vinyl mode.
  for (let i = 0; i < 5; i++) {
    await page.locator("#stage-vinyl-toggle").click();
    await page.waitForTimeout(40);
  }
  await expect(page.locator("body")).toHaveClass(/stage-vinyl/);
  await page.waitForTimeout(600);

  const degBeforeSkip = await page
    .locator("#now-cover")
    .evaluate((el) =>
      parseFloat(el.style.getPropertyValue("--vinyl-deg") || "0"),
    );
  expect(degBeforeSkip).toBeGreaterThan(2);

  // Skip to next track while Vinyl is spinning: cover crossfades while --vinyl-deg continues smoothly.
  await page.locator("#next").click();
  await expect(page.locator("#now-name")).toContainText("流光曲目 2");
  await page.waitForTimeout(450);
  const degAfterSkip = await page
    .locator("#now-cover")
    .evaluate((el) =>
      parseFloat(el.style.getPropertyValue("--vinyl-deg") || "0"),
    );
  expect(degAfterSkip).toBeGreaterThan(2);

  // Switch back to square mode: --vinyl-deg is cleared and cover transform is clean ("none").
  await page.locator("#stage-vinyl-toggle").click();
  await expect(page.locator("body")).not.toHaveClass(/stage-vinyl/);
  await page.waitForTimeout(350);
  const squareState = await page.locator("#now-cover").evaluate((cover) => {
    const img = cover.querySelector("img");
    return {
      varDeg: cover.style.getPropertyValue("--vinyl-deg").trim(),
      transform: img ? getComputedStyle(img).transform : "none",
      rotate: img ? getComputedStyle(img).rotate : "none",
    };
  });
  expect(squareState.varDeg).toBe("");
  expect(squareState.transform).toBe("none");
  expect(squareState.rotate).toBe("none");

  // Rapidly toggle Theater mode, then verify clicking .brand exits Theater mode cleanly.
  await page.locator("#stage-theater-toggle").click();
  await expect(page.locator("body")).toHaveClass(/stage-theater/);
  await page.locator("#stage-theater-toggle").click();
  await expect(page.locator("body")).not.toHaveClass(/stage-theater/);
  await page.locator("#stage-theater-toggle").click();
  await expect(page.locator("body")).toHaveClass(/stage-theater/);
  await page.locator(".brand").click();
  await expect(page.locator("body")).not.toHaveClass(/stage-theater/);
  await expect(page.locator(".library")).toBeVisible();

  // Lyrics interaction: open, scroll manually, click lyric line to seek, close & reopen rapidly.
  await expect(page.locator("#lyrics-panel")).toBeVisible();
  await expect(page.locator("#lyrics p").nth(3)).toBeVisible();
  await page.locator("#lyrics p").nth(3).click();
  await expect(page.locator("#lyrics p").nth(3)).toHaveClass(/current/);
  for (let i = 0; i < 4; i++) {
    await page.locator("#lyrics-toggle").click();
    await page.waitForTimeout(60);
  }
  await expect(page.locator("#lyrics-panel")).toBeVisible();
  expect(errors).toEqual([]);
});

test("adversarial stress pass 3: multi-viewport layout integrity and reduced-motion compliance", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
  });

  await page.emulateMedia({ reducedMotion: "reduce" });
  await desktopFixture(page);

  const viewports = [
    { width: 1440, height: 860 },
    { width: 1040, height: 700 },
    { width: 480, height: 720 },
    { width: 393, height: 852 },
    { width: 844, height: 390 },
  ];

  // Navigate into a playlist first so back button pinning is tested across viewports.
  await page.setViewportSize(viewports[0]);
  await page.locator('[data-view="playlists"]').click();
  await page.locator('[data-playlist="netease:201"]').click();
  await expect(page.locator("#back-button")).toBeVisible();

  for (const vp of viewports) {
    await page.setViewportSize(vp);
    await page.waitForTimeout(100);
    await page
      .locator(".main-scroll")
      .evaluate((el) => (el.scrollTop = el.scrollHeight));
    await expect(page.locator("#back-button")).toBeInViewport();
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  }

  // Under reduced motion, playing + vinyl mode must leave zero running CSS animations on .now-card.
  await page.setViewportSize({ width: 1440, height: 860 });
  await page.locator(".song-row").first().dblclick();
  await expect(page.locator("body")).toHaveAttribute(
    "data-playback",
    "playing",
  );
  await page.locator("#stage-vinyl-toggle").click();
  await page.waitForTimeout(200);
  const runningAnimations = await page
    .locator(".now-card")
    .evaluate((el) => el.getAnimations({ subtree: true }).length);
  expect(runningAnimations).toBe(0);
  expect(errors).toEqual([]);
});
