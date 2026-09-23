import { test, expect, type Page } from "@playwright/test";

function silence(seconds: number) {
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

async function setup(
  page: Page,
  seconds = 6,
  settings: Record<string, string> = {},
) {
  await page.route("**/__stream/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "audio/wav",
      body: silence(seconds),
      headers: { "Access-Control-Allow-Origin": "*" },
    }),
  );
  await page.addInitScript((prefs) => {
    const w = window as any;
    if (!sessionStorage.getItem("seeded")) {
      sessionStorage.setItem("seeded", "1");
      for (const [k, v] of Object.entries(prefs))
        localStorage.setItem(k, v as string);
    }
    Object.defineProperty(window, "isTauri", { value: true });
    w.__calls = [];
    w.__volumes = [];
    w.__contexts = 0;
    const descriptor = Object.getOwnPropertyDescriptor(
      HTMLMediaElement.prototype,
      "volume",
    )!;
    Object.defineProperty(HTMLMediaElement.prototype, "volume", {
      get() {
        return descriptor.get!.call(this);
      },
      set(v) {
        if (!(this as any).muted) w.__volumes.push(v);
        descriptor.set!.call(this, v);
      },
    });
    const Original = window.AudioContext;
    (window as any).AudioContext = class extends Original {
      constructor() {
        super();
        w.__contexts++;
      }
    };
    const song = (id: number, name: string, gain?: number) => ({
      id,
      ...(gain !== undefined ? { source: "qq", mid: "m" + id, gain } : {}),
      name,
      artist: "测试歌手",
      album: "测试专辑",
      cover: "",
      duration: 6000,
      fee: 0,
    });
    w.__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args: any = {}) => {
        const op = cmd === "qq_request" ? args.operation : cmd;
        const a = cmd === "qq_request" ? args.args : args;
        w.__calls.push({ op, args: a });
        if (op === "search_songs")
          return {
            songs:
              cmd === "qq_request"
                ? [song(8, "很响的歌", -13)]
                : [
                    song(1, "第一首"),
                    song(2, "第二首"),
                    song(3, "第三首"),
                    song(4, "第四首"),
                  ],
            total: 4,
          };
        if (op === "account_status") return null;
        if (op === "catalog_search")
          return { artists: [], albums: [], playlists: [], total: 0 };
        if (op === "song_url")
          return {
            url: `/__stream/${a.id}.wav`,
            trial: false,
            trialStart: 0,
            bitrate: 320000,
            level: "exhigh",
            requestedLevel: "exhigh",
            format: "mp3",
          };
        if (op === "song_lyric") return "";
        if (op === "local_restore") return [];
        if (op === "local_scan")
          return { folders: [], download_folder: null, tracks: [] };
        return null;
      },
    };
  }, settings);
  await page.goto("/");
  await expect(page.locator(".song-row")).toHaveCount(4);
}
const urlCalls = (page: Page) =>
  page.evaluate(() =>
    (window as any).__calls
      .filter((c: any) => c.op === "song_url")
      .map((c: any) => c.args.id),
  );

test("the next song's stream is fetched ahead, so skipping needs no request", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 760 });
  await setup(page, 6);
  await page.locator('[data-song="netease:1"]').dblclick();
  await expect(page.locator("#toggle")).toHaveAttribute("aria-label", "暂停");
  // Not while the listener may still be choosing, but well before the end.
  expect(await urlCalls(page)).toEqual([1]);
  await expect.poll(() => urlCalls(page), { timeout: 6000 }).toEqual([1, 2]);
  await page.locator("#next").click();
  await expect(page.locator("#now-name")).toHaveText("第二首");
  await expect.poll(() => urlCalls(page)).toEqual([1, 2, 3]);
});

test("crossfading starts the next song before the last one ends, fading it in", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 760 });
  await setup(page, 4, { "ting.crossfade": "2" });
  await page.locator('[data-song="netease:1"]').dblclick();
  await expect(page.locator("#toggle")).toHaveAttribute("aria-label", "暂停");
  const started = Date.now();
  await expect(page.locator("#now-name")).toHaveText("第二首", {
    timeout: 6000,
  });
  // A 4 s song with a 2 s crossfade hands over around the 2 s mark.
  expect(Date.now() - started).toBeLessThan(3800);
  // Short songs keep crossfading into each other, so check the shape: the
  // incoming song starts low and climbs back to the slider's level.
  await expect
    .poll(async () => {
      const volumes: number[] = await page.evaluate(
        () => (window as any).__volumes,
      );
      const low = volumes.findIndex((v) => v > 0 && v < 0.6);
      return low >= 0 && volumes.slice(low).some((v) => v > 0.69);
    })
    .toBe(true);
});

test("stop after this song pauses at its end instead of moving on", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 760 });
  await setup(page, 2);
  await page.locator('[data-song="netease:1"]').dblclick();
  await page.locator("#sound-button").click();
  await page.locator('[data-sleep="track"]').click();
  await page.locator("[data-sound-close]").click();
  await expect(page.locator("#sound-button")).toHaveAttribute(
    "data-sleep",
    "track",
  );
  await expect(page.locator("#toggle")).toHaveAttribute("aria-label", "播放", {
    timeout: 5000,
  });
  await expect(page.locator("#now-name")).toHaveText("第一首");
  await expect(page.locator("#sound-button")).toHaveAttribute(
    "data-sleep",
    "off",
  );
});

test("loudness normalisation lowers a loud track without moving the slider", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 760 });
  await setup(page, 6, { "ting.normalize": "1", "ting.volume": "0.8" });
  await page.locator("#search-source").selectOption("qq");
  await page.locator('[data-song="qq:8"]').dblclick();
  await expect(page.locator("#toggle")).toHaveAttribute("aria-label", "暂停");
  // 6 dB louder than the -7 dB reference: played at half the slider.
  await expect
    .poll(async () =>
      (await page.evaluate(() => (window as any).__volumes)).at(-1),
    )
    .toBeCloseTo(0.4, 2);
  await page.locator("#search-source").selectOption("netease");
  await page.locator('[data-song="netease:1"]').dblclick();
  // No loudness figure: treated as typical, so it plays at the slider too.
  await expect
    .poll(async () =>
      (await page.evaluate(() => (window as any).__volumes)).at(-1),
    )
    .toBeCloseTo(0.8, 2);
  expect(await page.locator("#volume").inputValue()).toBe("0.8");
});

test("an equaliser preset routes playback through Web Audio on desktop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 760 });
  await setup(page, 6);
  await page.locator('[data-song="netease:1"]').dblclick();
  await expect(page.locator("#toggle")).toHaveAttribute("aria-label", "暂停");
  expect(await page.evaluate(() => (window as any).__contexts)).toBe(0);
  await page.locator("#sound-button").click();
  await page.locator('[data-eq="bass"]').click();
  await expect(page.locator('[data-eq="bass"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(await page.evaluate(() => (window as any).__contexts)).toBe(1);
  // The song reloads once, at its position, to pass through the filters.
  await expect.poll(() => urlCalls(page)).toContain(1);
  await expect(page.locator("#sound-button")).toHaveClass(/active/);
  expect(await page.evaluate(() => localStorage.getItem("ting.eq"))).toBe(
    "bass",
  );
});

test("recently played keeps what started, newest first, across a restart", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 760 });
  await setup(page, 6);
  await page.locator('[data-song="netease:1"]').dblclick();
  // Only a song that actually started counts as played.
  await expect(page.locator("#elapsed")).toHaveText("0:01", { timeout: 5000 });
  await page.locator('[data-song="netease:3"]').dblclick();
  await expect(page.locator("#now-name")).toHaveText("第三首");
  await expect(page.locator("#elapsed")).toHaveText("0:01", { timeout: 5000 });
  await page.reload();
  await page.locator('[data-view="queue"]').click();
  await page.locator('[data-queue-tab="history"]').click();
  await expect(page.locator(".song-row")).toHaveCount(2);
  await expect(page.locator(".song-row").first()).toContainText("第三首");
  await expect(page.locator(".song-row [data-remove]")).toHaveCount(0);
  await page.locator("#clear-list").click();
  await expect(page.locator(".song-row")).toHaveCount(0);
});

test("play next, drag to reorder and clearing all shape the queue", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 760 });
  await setup(page, 30);
  await page.locator('[data-song="netease:1"]').dblclick();
  await expect(page.locator("#toggle")).toHaveAttribute("aria-label", "暂停");
  await page.locator('[data-song-menu="netease:4"]').click();
  await page.locator("#song-next").click();
  await page.locator('[data-view="queue"]').click();
  const order = () =>
    page
      .locator(".song-row")
      .evaluateAll((rows) => rows.map((r) => (r as HTMLElement).dataset.song));
  await expect
    .poll(order)
    .toEqual(["netease:1", "netease:4", "netease:2", "netease:3"]);
  await page
    .locator('[data-song="netease:3"]')
    .dragTo(page.locator('[data-song="netease:1"]'), {
      targetPosition: { x: 40, y: 5 },
    });
  await expect
    .poll(order)
    .toEqual(["netease:3", "netease:1", "netease:4", "netease:2"]);
  await page.locator("#clear-list").click();
  await expect.poll(order).toEqual(["netease:1"]);
  await expect(page.locator("#toggle")).toHaveAttribute("aria-label", "暂停");
});
