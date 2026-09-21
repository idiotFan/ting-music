import { invoke } from "@tauri-apps/api/core";

export type PhoneLoginResult = {
  code: number;
  profile: { userId: number; nickname: string; avatar: string } | null;
  warning?: string;
};
let nextSendAt = 0;

/** Only keep the mounted form and resend deadline in memory. */
export function mountPhoneLogin(
  container: HTMLElement,
  status: HTMLElement,
  isCurrent: () => boolean,
  complete: (result: PhoneLoginResult) => void,
) {
  container.innerHTML = `<form id="phone-login-form" autocomplete="on">
    <label for="login-phone">手机号</label>
    <div class="phone-number-row"><label class="sr-only" for="login-country">国家或地区代码</label><span>+</span><input id="login-country" aria-label="国家或地区代码" value="86" type="tel" inputmode="numeric" autocomplete="tel-country-code" maxlength="4" required/><input id="login-phone" type="tel" inputmode="tel" autocomplete="tel-national" placeholder="输入手机号" maxlength="20" required/></div>
    <label for="login-code">短信验证码</label>
    <div class="phone-code-row"><input id="login-code" type="text" inputmode="numeric" autocomplete="one-time-code" placeholder="输入验证码" maxlength="6" required/><button id="send-login-code" class="outline" type="button">获取验证码</button></div>
    <button id="phone-login-submit" class="primary" type="submit">登录网易云</button>
    <p class="summary">使用你已有的网易云账号。手机号和验证码仅用于本次登录，不保存在设备上。</p>
  </form>`;
  const field = (id: string) => container.querySelector<HTMLInputElement>(id)!;
  const phone = field("#login-phone"),
    country = field("#login-country"),
    code = field("#login-code");
  const send = container.querySelector<HTMLButtonElement>("#send-login-code")!;
  const submit = container.querySelector<HTMLButtonElement>(
    "#phone-login-submit",
  )!;
  let busy = false,
    disposed = false;
  const active = () => !disposed && isCurrent();
  const validPhone = () =>
    phone.value.length + country.value.length <= 15 &&
    /^[1-9]\d{0,2}$/.test(country.value) &&
    (country.value === "86"
      ? /^1\d{10}$/.test(phone.value)
      : /^\d{6,14}$/.test(phone.value));
  function update() {
    const seconds = Math.max(0, Math.ceil((nextSendAt - Date.now()) / 1000));
    send.textContent = seconds ? `${seconds}s 后重试` : "获取验证码";
    send.disabled = busy || !!seconds || !validPhone();
    submit.disabled = busy || !validPhone() || !/^\d{4,6}$/.test(code.value);
    phone.disabled = country.disabled = code.disabled = busy;
  }
  [phone, country, code].forEach((input) =>
    input.addEventListener("input", () => {
      country.value = country.value.trim().replace(/^\+/, "");
      phone.value = phone.value.replace(/[\s()-]/g, "");
      if (country.value && phone.value.startsWith(`+${country.value}`)) {
        phone.value = phone.value.slice(country.value.length + 1);
      }
      code.value = code.value.replace(/\s/g, "");
      update();
    }),
  );
  send.onclick = async () => {
    if (send.disabled) return;
    busy = true;
    update();
    status.textContent = "正在发送验证码…";
    try {
      await invoke("send_login_code", {
        phone: phone.value,
        country: country.value,
      });
      // Only a successful send starts the cooldown; failures stay resendable.
      nextSendAt = Date.now() + 60_000;
      if (active()) {
        status.textContent = "验证码已发送，请查看手机短信";
      }
    } catch (error) {
      if (active()) status.textContent = String(error);
    } finally {
      busy = false;
      if (active()) {
        update();
        code.focus();
      }
    }
  };
  container.querySelector("form")!.onsubmit = async (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    busy = true;
    code.blur();
    update();
    status.textContent = "正在确认登录…";
    try {
      const result = await invoke<PhoneLoginResult>("login_phone", {
        phone: phone.value,
        country: country.value,
        code: code.value,
      });
      if (!active()) return;
      if (result.code !== 803 || !result.profile)
        throw new Error("未取得账号信息，请重新获取验证码");
      complete(result);
    } catch (error) {
      if (active()) status.textContent = String(error);
    } finally {
      busy = false;
      if (active()) update();
    }
  };
  update();
  const timer = window.setInterval(update, 1000);
  return () => {
    disposed = true;
    window.clearInterval(timer);
    phone.value = code.value = "";
  };
}
