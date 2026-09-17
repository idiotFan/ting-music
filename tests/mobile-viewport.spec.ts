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
    const viewport = Object.assign(new EventTarget(), {
      height: innerHeight,
      width: innerWidth,
      offsetTop: 0,
      offsetLeft: 0,
      scale: 1,
    });
    // A real iOS keyboard can change only these values; the layout viewport stays put.
    Object.defineProperty(window, "visualViewport", { value: viewport });
    w.__changeVisualViewport = (patch: object, event = "resize") => {
      Object.assign(viewport, patch);
      viewport.dispatchEvent(new Event(event));
    };
    Object.defineProperty(window, "isTauri", { value: true });
    w.__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args: any = {}) => {
        const operation = cmd === "qq_request" ? args.operation : cmd;
        if (operation === "search_songs") return { songs: [], total: 0 };
        return null;
      },
    };
  });
  await page.goto("/");
}

async function viewportChange(
  page: Page,
  patch: { height?: number; offsetTop?: number; scale?: number },
  event = "resize",
) {
  await page.evaluate(
    ({ patch, event }) => (window as any).__changeVisualViewport(patch, event),
    { patch, event },
  );
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

const cssValue = (page: Page, name: string) =>
  page.evaluate(
    (name) => document.documentElement.style.getPropertyValue(name),
    name,
  );

test("SMS sheet and the focused field stay above an iOS keyboard without resizing the layout viewport", async ({
  browser,
}) => {
  const context = await browser.newContext(phone);
  const page = await context.newPage();
  await setup(page);
  await page.locator("#account-button").tap();
  await expect(page.locator("#phone-login-form")).toBeVisible();
  await page.locator("#login-code").focus();
  await viewportChange(page, { height: 390, offsetTop: 84 });
  expect(await page.evaluate(() => innerHeight)).toBe(852);
  expect(await page.evaluate(() => document.documentElement.clientHeight)).toBe(
    852,
  );
  await expect(page.locator("html")).toHaveClass(/keyboard-open/);
  expect(await cssValue(page, "--mobile-viewport-height")).toBe("390px");
  expect(await cssValue(page, "--mobile-keyboard-inset")).toBe("378px");
  const sheet = (await page.locator("#account-dialog").boundingBox())!;
  const field = (await page.locator("#login-code").boundingBox())!;
  expect(sheet.y).toBeGreaterThanOrEqual(84);
  expect(sheet.y + sheet.height).toBeLessThanOrEqual(474);
  expect(field.y).toBeGreaterThanOrEqual(sheet.y);
  expect(field.y + field.height).toBeLessThanOrEqual(474 - 16);
  expect(await page.evaluate(() => scrollY)).toBe(0);
  // iOS can pan the visible region while the keyboard height stays unchanged.
  await viewportChange(page, { offsetTop: 40 }, "scroll");
  const moved = (await page.locator("#account-dialog").boundingBox())!;
  expect(moved.y).toBeGreaterThanOrEqual(40);
  expect(moved.y + moved.height).toBeLessThanOrEqual(430);
  // A large keyboard pan must not be confused with the keyboard closing.
  await viewportChange(page, { offsetTop: 400 }, "scroll");
  await expect(page.locator("html")).toHaveClass(/keyboard-open/);
  expect(await cssValue(page, "--mobile-keyboard-inset")).toBe("62px");
  const panned = (await page.locator("#login-code").boundingBox())!;
  expect(panned.y).toBeGreaterThanOrEqual(400);
  expect(panned.y + panned.height).toBeLessThanOrEqual(790 - 16);
  await context.close();
});

test("search follows the visible viewport and restores the bottom safe area after the keyboard closes", async ({
  browser,
}) => {
  const context = await browser.newContext(phone);
  const page = await context.newPage();
  await setup(page);
  // Chromium reports zero env() insets; exercise the same CSS variable with an iPhone inset.
  await page.addStyleTag({
    content: ".mobile-device { --mobile-bottom-safe: 34px; }",
  });
  expect(
    await page
      .locator("body")
      .evaluate((el) => getComputedStyle(el).paddingBottom),
  ).toBe("34px");
  await page.locator("#search").focus();
  await viewportChange(page, { height: 420, offsetTop: 30 });
  expect(await page.evaluate(() => innerHeight)).toBe(852);
  const search = (await page.locator("#search").boundingBox())!;
  const app = (await page.locator("#app").boundingBox())!;
  expect(search.y).toBeGreaterThanOrEqual(30);
  expect(search.y + search.height).toBeLessThanOrEqual(450);
  expect(app.y).toBe(30);
  expect(app.y + app.height).toBe(450);
  await expect(page.locator(".player")).toBeHidden();
  expect(
    await page
      .locator("body")
      .evaluate((el) => getComputedStyle(el).paddingBottom),
  ).toBe("0px");
  await page.locator("#search").blur();
  await viewportChange(page, { height: 852, offsetTop: 0 });
  await expect(page.locator("html")).not.toHaveClass(/keyboard-open/);
  expect(await cssValue(page, "--mobile-keyboard-inset")).toBe("0px");
  expect(
    await page
      .locator("body")
      .evaluate((el) => getComputedStyle(el).paddingBottom),
  ).toBe("34px");
  await expect(page.locator(".player")).toBeVisible();
  const restored = (await page.locator("#app").boundingBox())!;
  expect(restored.y).toBe(0);
  expect(restored.height).toBe(818);
  await context.close();
});

test("pinch zoom does not resize or shift the app and unchanged events do not mutate its styles", async ({
  browser,
}) => {
  const context = await browser.newContext(phone);
  const page = await context.newPage();
  await setup(page);
  const before = await page.locator("html").getAttribute("style");
  await viewportChange(page, { scale: 2, height: 426, offsetTop: 90 });
  expect(await page.locator("html").getAttribute("style")).toBe(before);
  await expect(page.locator("html")).not.toHaveClass(/keyboard-open/);
  await viewportChange(page, { scale: 1, height: 852, offsetTop: 0 });
  await page.evaluate(() => {
    const w = window as any;
    w.__viewportMutations = 0;
    w.__viewportObserver = new MutationObserver((records) => {
      w.__viewportMutations += records.length;
    });
    w.__viewportObserver.observe(document.documentElement, {
      attributes: true,
    });
  });
  await page.locator(".brand").focus();
  await viewportChange(page, { height: 852, offsetTop: 0 }, "resize");
  await viewportChange(page, { height: 852, offsetTop: 0 }, "scroll");
  expect(await page.evaluate(() => (window as any).__viewportMutations)).toBe(
    0,
  );
  await context.close();
});

test("desktop windows ignore the mobile viewport adapter", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 480, height: 720 },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
    isMobile: false,
    hasTouch: false,
  });
  const page = await context.newPage();
  await setup(page);
  await expect(page.locator("html")).not.toHaveClass(/mobile-device/);
  await page.locator("#search").focus();
  await viewportChange(page, { height: 340, offsetTop: 60 });
  expect(await cssValue(page, "--mobile-viewport-height")).toBe("");
  expect(await cssValue(page, "--mobile-viewport-top")).toBe("");
  expect(await cssValue(page, "--mobile-keyboard-inset")).toBe("");
  expect((await page.locator("#app").boundingBox())!.height).toBe(720);
  await expect(page.locator(".player")).toBeVisible();
  await context.close();
});
