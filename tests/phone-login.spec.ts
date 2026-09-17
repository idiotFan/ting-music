import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import jsQR from "jsqr";

const phoneNumber = "13800000000";
const smsCode = "761249";
const neteaseQr = "https://music.163.com/login?codekey=phone-login-qa-only";
const qqQr = "https://example.com/ting/test/wechat-qr?fixture=synthetic-470";

test.use({
  viewport: { width: 393, height: 852 },
  isMobile: true,
  hasTouch: true,
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile",
});

async function setup(page: Page) {
  await page.addInitScript(
    ({ qrImage, neteaseQr }) => {
      const w = window as any;
      w.__phoneCalls = [];
      w.__pendingPhone = {};
      w.__settledPhone = {};
      w.__phoneLoggedIn = false;
      const profile = { userId: 901, nickname: "短信测试账号", avatar: "" };
      Object.defineProperty(window, "isTauri", { value: true });
      w.__TAURI_INTERNALS__ = {
        invoke: async (cmd: string, args: any = {}) => {
          const operation = cmd === "qq_request" ? args.operation : cmd;
          const source = cmd === "qq_request" ? "qq" : "netease";
          w.__phoneCalls.push({ operation, source, args });
          if (operation === "account_status")
            return source === "netease" && w.__phoneLoggedIn ? profile : null;
          if (operation === "search_songs") return { songs: [], total: 0 };
          if (operation === "my_playlists")
            return { playlists: [], more: false };
          if (operation === "login_qr_start")
            return { key: "phone-test-qr", url: neteaseQr, image: qrImage };
          if (operation === "login_qr_check") return { code: 801 };
          if (operation === "send_login_code" || operation === "login_phone") {
            const result = await new Promise((resolve, reject) => {
              w.__pendingPhone[operation] = { resolve, reject };
            });
            w.__settledPhone[operation] =
              (w.__settledPhone[operation] || 0) + 1;
            return result;
          }
          return null;
        },
      };
    },
    {
      neteaseQr,
      qrImage:
        "data:image/jpeg;base64," +
        readFileSync("tests/fixtures/wechat-login-470.jpg").toString("base64"),
    },
  );
  await page.goto("/");
  await page.locator("#account-button").tap();
  await expect(page.locator("#phone-login-form")).toBeVisible();
}

const callCount = (page: Page, operation: string) =>
  page.evaluate(
    (operation) =>
      (window as any).__phoneCalls.filter(
        (call: any) => call.operation === operation,
      ).length,
    operation,
  );

async function resolveRequest(page: Page, operation: string, success = true) {
  await page.evaluate(
    ({ operation, success }) => {
      const w = window as any;
      w.__pendingPhone[operation].resolve(
        operation === "login_phone"
          ? {
              code: success ? 803 : 400,
              profile: success
                ? { userId: 901, nickname: "短信测试账号", avatar: "" }
                : null,
            }
          : null,
      );
    },
    { operation, success },
  );
  await expect
    .poll(() =>
      page.evaluate(
        (operation) => (window as any).__settledPhone[operation],
        operation,
      ),
    )
    .toBeGreaterThan(0);
}

async function fillLogin(page: Page) {
  await page.locator("#login-country").fill("+86");
  await page.locator("#login-phone").fill("+86 138 0000 0000");
  await expect(page.locator("#login-country")).toHaveValue("86");
  await expect(page.locator("#login-phone")).toHaveValue(phoneNumber);
  await page.locator("#login-code").fill(smsCode);
}

async function expectNoStoredLoginFields(page: Page) {
  const stored = await page.evaluate(() =>
    JSON.stringify({
      local: { ...localStorage },
      session: { ...sessionStorage },
    }),
  );
  expect(stored).not.toContain(phoneNumber);
  expect(stored).not.toContain(smsCode);
}

test("mobile defaults to SMS and validates inputs before sending with a resend cooldown", async ({
  page,
}) => {
  await page.clock.install();
  await setup(page);
  await expect(page.locator("#login-qr")).toHaveCount(0);
  await expect(page.locator("#refresh-qr")).toBeHidden();
  await expect(page.locator("#share-login-qr")).toBeHidden();
  expect(await callCount(page, "login_qr_start")).toBe(0);
  await expect(page.locator("#send-login-code")).toBeDisabled();
  await expect(page.locator("#phone-login-submit")).toBeDisabled();
  await page.locator("#login-phone").fill("138");
  await expect(page.locator("#send-login-code")).toBeDisabled();
  await page.locator("#login-phone").fill(phoneNumber);
  await page.locator("#login-country").fill("invalid");
  await expect(page.locator("#send-login-code")).toBeDisabled();
  await page.locator("#login-country").fill("86");
  await expect(page.locator("#send-login-code")).toBeEnabled();
  await page.locator("#login-code").fill("abc");
  await expect(page.locator("#phone-login-submit")).toBeDisabled();
  await page.locator("#login-code").fill("123");
  await expect(page.locator("#phone-login-submit")).toBeDisabled();
  await page.locator("#send-login-code").tap();
  await expect(page.locator("#send-login-code")).toBeDisabled();
  await expect(page.locator("#login-phone")).toBeDisabled();
  await page
    .locator("#send-login-code")
    .evaluate((button: HTMLButtonElement) => button.click());
  expect(await callCount(page, "send_login_code")).toBe(1);
  await resolveRequest(page, "send_login_code");
  await expect(page.locator("#account-status")).toContainText("验证码已发送");
  await expect(page.locator("#login-code")).toBeFocused();
  await expect(page.locator("#send-login-code")).toBeDisabled();
  await page.clock.fastForward(59_000);
  await expect(page.locator("#send-login-code")).toBeDisabled();
  await page.clock.fastForward(1_000);
  await expect(page.locator("#send-login-code")).toBeEnabled();
  await page.locator("#send-login-code").tap();
  expect(await callCount(page, "send_login_code")).toBe(2);
  await resolveRequest(page, "send_login_code");
  await expectNoStoredLoginFields(page);
});

test("SMS login prevents duplicate submission, completes the account flow, and clears sensitive fields", async ({
  page,
}) => {
  await setup(page);
  await fillLogin(page);
  await page.locator("#phone-login-submit").tap();
  await expect(page.locator("#phone-login-submit")).toBeDisabled();
  await page
    .locator("#phone-login-form")
    .evaluate((form: HTMLFormElement) => form.requestSubmit());
  expect(await callCount(page, "login_phone")).toBe(1);
  const request = await page.evaluate(
    () =>
      (window as any).__phoneCalls.find(
        (call: any) => call.operation === "login_phone",
      ).args,
  );
  expect(request).toEqual({ phone: phoneNumber, country: "86", code: smsCode });
  await resolveRequest(page, "login_phone");
  await expect(page.locator("#account-dialog")).toBeHidden();
  await expect(page.locator("#account-name")).toHaveText("短信测试账号");
  await expect(page.locator("#toast")).toContainText("欢迎回来");
  await expect.poll(() => callCount(page, "my_playlists")).toBeGreaterThan(0);
  expect(await page.locator("#login-phone").inputValue()).toBe("");
  expect(await page.locator("#login-code").inputValue()).toBe("");
  await expectNoStoredLoginFields(page);
});

test("an unsuccessful SMS login leaves the form available to retry without logging in", async ({
  page,
}) => {
  await setup(page);
  await fillLogin(page);
  await page.locator("#phone-login-submit").tap();
  await resolveRequest(page, "login_phone", false);
  await expect(page.locator("#account-status")).toContainText("未取得账号信息");
  await expect(page.locator("#phone-login-submit")).toBeEnabled();
  await expect(page.locator("#login-phone")).toBeEnabled();
  await expect(page.locator("#account-name")).toHaveText("登录");
  await expect(page.locator("#account-dialog")).toBeVisible();
  await expectNoStoredLoginFields(page);
});

for (const operation of ["send_login_code", "login_phone"]) {
  for (const action of ["close", "switch-provider", "switch-method"]) {
    test(`late ${operation} response cannot update a form after ${action}`, async ({
      page,
    }) => {
      await setup(page);
      await fillLogin(page);
      await page.evaluate(() => {
        (window as any).__disposedPhoneFields = [
          document.querySelector("#login-phone"),
          document.querySelector("#login-code"),
        ];
      });
      await page
        .locator(
          operation === "send_login_code"
            ? "#send-login-code"
            : "#phone-login-submit",
        )
        .tap();
      expect(await callCount(page, operation)).toBe(1);
      if (action === "close") await page.locator("#account-close").tap();
      else if (action === "switch-provider")
        await page.locator("#account-qq").tap();
      else await page.locator('[data-netease-method="qr"]').tap();
      await expect
        .poll(() => callCount(page, "login_qr_cancel"))
        .toBeGreaterThan(0);
      if (action !== "close")
        await expect(page.locator("#login-qr")).toBeVisible();
      await resolveRequest(page, operation);
      await expect(page.locator("#account-name")).toHaveText("登录");
      await expect(page.locator("#toast")).not.toContainText("欢迎回来");
      if (action === "close")
        await expect(page.locator("#account-dialog")).toBeHidden();
      else {
        await expect(page.locator("#account-dialog")).toBeVisible();
        await expect(page.locator("#login-qr")).toBeVisible();
        await expect(page.locator("#account-title")).toHaveText(
          action === "switch-provider" ? "登录QQ音乐" : "登录网易云",
        );
        await expect(page.locator("#account-status")).not.toContainText(
          "验证码已发送",
        );
      }
      expect(
        await page.evaluate(() =>
          (window as any).__disposedPhoneFields.map(
            (field: HTMLInputElement) => field.value,
          ),
        ),
      ).toEqual(["", ""]);
      await expectNoStoredLoginFields(page);
      if (action === "close") await page.locator("#account-button").tap();
      else if (action === "switch-provider")
        await page.locator("#account-netease").tap();
      else await page.locator('[data-netease-method="phone"]').tap();
      await expect(page.locator("#phone-login-form")).toBeVisible();
      await expect(page.locator("#login-phone")).toHaveValue("");
      await expect(page.locator("#login-code")).toHaveValue("");
    });
  }
}

for (const provider of ["netease", "qq"]) {
  test(`${provider} shares a decoded PNG with exactly the displayed QR pixels`, async ({
    page,
  }) => {
    await setup(page);
    if (provider === "netease")
      await page.locator('[data-netease-method="qr"]').tap();
    else {
      await page.locator("#account-qq").tap();
      await page.locator('[data-qq-kind="wx"]').tap();
    }
    await expect(page.locator("#login-qr")).toBeVisible();
    await expect(page.locator("#share-login-qr")).toBeVisible();
    const displayedSrc = (await page.locator("#login-qr").getAttribute("src"))!;
    const displayed = PNG.sync.read(
      Buffer.from(displayedSrc.split(",")[1], "base64"),
    );
    await page.locator("#share-login-qr").tap();
    await expect.poll(() => callCount(page, "share_login_qr")).toBe(1);
    const sharedSrc = await page.evaluate(
      () =>
        (window as any).__phoneCalls.find(
          (call: any) => call.operation === "share_login_qr",
        ).args.dataUrl,
    );
    expect(sharedSrc).toMatch(/^data:image\/png;base64,/);
    const shared = PNG.sync.read(
      Buffer.from(sharedSrc.split(",")[1], "base64"),
    );
    expect(shared.width).toBe(displayed.width);
    expect(shared.height).toBe(displayed.height);
    expect(shared.data.equals(displayed.data)).toBe(true);
    expect(
      jsQR(new Uint8ClampedArray(shared.data), shared.width, shared.height)
        ?.data,
    ).toBe(provider === "netease" ? neteaseQr : qqQr);
    await expect(page.locator("#share-login-qr")).toBeEnabled();
  });
}

test("QR sharing refuses a payload mismatch before calling the native share sheet", async ({
  page,
}) => {
  await setup(page);
  await page.locator('[data-netease-method="qr"]').tap();
  await expect(page.locator("#login-qr")).toBeVisible();
  await page.locator("#login-qr").evaluate((qr: HTMLElement) => {
    qr.dataset.payload = "https://invalid.example/changed";
  });
  await page.locator("#share-login-qr").tap();
  await expect(page.locator("#toast")).toContainText("二维码");
  expect(await callCount(page, "share_login_qr")).toBe(0);
  await expect(page.locator("#share-login-qr")).toBeEnabled();
});

test("the phone login sheet remains scrollable when the keyboard reduces a small viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await setup(page);
  await fillLogin(page);
  await page.setViewportSize({ width: 320, height: 360 });
  const dialog = page.locator("#account-dialog");
  const dimensions = await dialog.evaluate((el) => ({
    scroll: el.scrollHeight,
    visible: el.clientHeight,
  }));
  expect(dimensions.scroll).toBeGreaterThan(dimensions.visible);
  await page.locator("#phone-login-submit").scrollIntoViewIfNeeded();
  const submit = (await page.locator("#phone-login-submit").boundingBox())!;
  expect(submit.y).toBeGreaterThanOrEqual(0);
  expect(submit.y + submit.height).toBeLessThanOrEqual(360);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    320,
  );
  await page.locator("#account-close").tap();
  await expect(dialog).toBeHidden();
  await expectNoStoredLoginFields(page);
});
