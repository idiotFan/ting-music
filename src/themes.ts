import { animateContent, openDialog, closeDialog } from "./motion";
import { readSetting, writeSetting } from "./settings";
export const themes = [
  {
    id: "sage",
    name: "晨绿",
    bg: "#f8faf5",
    surface: "#fcfdf9",
    ink: "#2d4034",
    muted: "#65715f",
    accent: "#36573d",
    line: "#e4e9de",
  },
  {
    id: "porcelain",
    name: "月白",
    bg: "#f4f5f7",
    surface: "#ffffff",
    ink: "#272d35",
    muted: "#656d78",
    accent: "#455b77",
    line: "#e3e6eb",
  },
  {
    id: "mist",
    name: "雾蓝",
    bg: "#f0f5fa",
    surface: "#fbfdff",
    ink: "#293b50",
    muted: "#617389",
    accent: "#376695",
    line: "#dce5ef",
  },
  {
    id: "sea",
    name: "海盐",
    bg: "#eff7f6",
    surface: "#fafffe",
    ink: "#264644",
    muted: "#5b7570",
    accent: "#28746a",
    line: "#dceae5",
  },
  {
    id: "apricot",
    name: "暖杏",
    bg: "#faf4ec",
    surface: "#fffcf7",
    ink: "#493d31",
    muted: "#7c6d5c",
    accent: "#916336",
    line: "#eadecf",
  },
  {
    id: "rose",
    name: "玫瑰",
    bg: "#faf2f4",
    surface: "#fffafb",
    ink: "#4c343e",
    muted: "#816875",
    accent: "#965b73",
    line: "#eedee5",
  },
  {
    id: "lavender",
    name: "藤紫",
    bg: "#f4f2f9",
    surface: "#fdfbff",
    ink: "#403750",
    muted: "#746a84",
    accent: "#775899",
    line: "#e6dfed",
  },
  {
    id: "sand",
    name: "砂岩",
    bg: "#f5f2ed",
    surface: "#fcfaf6",
    ink: "#403d37",
    muted: "#747065",
    accent: "#716248",
    line: "#e5dfd5",
  },
  {
    id: "midnight",
    name: "午夜蓝",
    bg: "#111923",
    surface: "#16202d",
    ink: "#e3eaf3",
    muted: "#a2b1c4",
    accent: "#90b7e6",
    line: "#2a3748",
    dark: true,
  },
  {
    id: "forest",
    name: "深墨绿",
    bg: "#101e19",
    surface: "#14261f",
    ink: "#e0ece4",
    muted: "#a1b6a7",
    accent: "#9ecbb0",
    line: "#2a4034",
    dark: true,
  },
  {
    id: "graphite",
    name: "石墨",
    bg: "#191a1d",
    surface: "#212226",
    ink: "#ebebed",
    muted: "#b0b0b8",
    accent: "#c8bddf",
    line: "#36373d",
    dark: true,
  },
];
// Two remembered choices: the light theme and the dark one. Following the
// system switches between them; otherwise the light slot is simply "the"
// theme (and may itself be a dark palette, as before).
const valid = (id: string, dark?: boolean) =>
  themes.some((t) => t.id === id && (dark === undefined || !!t.dark === dark));
let lightChoice = readSetting("ting.theme") || "sage";
if (!valid(lightChoice)) lightChoice = "sage";
let darkChoice = readSetting("ting.theme-dark") || "midnight";
if (!valid(darkChoice, true)) darkChoice = "midnight";
let follow = readSetting("ting.theme-follow") === "1";
const systemDark = window.matchMedia("(prefers-color-scheme: dark)");
const wanted = () =>
  !follow ? lightChoice : systemDark.matches ? darkChoice : lightChoice;
// Following the system needs a light palette in the light slot.
if (follow && !valid(lightChoice, false)) lightChoice = "sage";
let selected = wanted();
function apply(id: string) {
  const t = themes.find((t) => t.id === id)!;
  const root = document.documentElement;
  root.dataset.theme = id;
  root.style.colorScheme = t.dark ? "dark" : "light";
  for (const key of [
    "bg",
    "surface",
    "ink",
    "muted",
    "accent",
    "line",
  ] as const)
    root.style.setProperty("--" + key, t[key]);
  root.style.setProperty("--on-accent", t.dark ? "#14201b" : "#ffffff");
  root.style.setProperty("--error", t.dark ? "#efa6a2" : "#9b443d");
  selected = id;
}
apply(selected);
export const themeFollowsSystem = () => follow;
/** For the helper windows: follow the main window's choices as they change. */
export function followThemeChanges() {
  const refresh = () => {
    lightChoice = readSetting("ting.theme") || "sage";
    if (!valid(lightChoice)) lightChoice = "sage";
    darkChoice = readSetting("ting.theme-dark") || "midnight";
    if (!valid(darkChoice, true)) darkChoice = "midnight";
    follow = readSetting("ting.theme-follow") === "1";
    if (follow && !valid(lightChoice, false)) lightChoice = "sage";
    apply(wanted());
  };
  window.addEventListener("storage", (e) => {
    if (e.key?.startsWith("ting.theme")) refresh();
  });
  systemDark.addEventListener("change", refresh);
}
export function setupThemes() {
  const dialog = document.createElement("dialog");
  dialog.id = "theme-dialog";
  dialog.setAttribute("aria-labelledby", "theme-title");
  dialog.innerHTML = `<button class="dialog-close icon-button" id="theme-close" aria-label="关闭主题选择">×</button><h2 id="theme-title">选一种心情</h2><p class="summary">晨绿 + 10 套配色，选择后立即生效。</p><label class="switch-row theme-follow"><span><strong>跟随系统深浅色</strong><small>系统切换到深色时换成下方选中的深色配色。</small></span><input type="checkbox" class="toggle" id="theme-follow"/></label><div class="theme-grid">${themes.map((t) => `<button class="theme-choice" data-theme-choice="${t.id}" aria-pressed="false"><span class="theme-preview" style="--swatch-bg:${t.bg};--swatch-surface:${t.surface};--swatch-ink:${t.ink};--swatch-accent:${t.accent}"><i></i><b></b><em></em></span><span>${t.name}</span></button>`).join("")}</div>`;
  document.body.append(dialog);
  let colorTimer = 0;
  const followBox = dialog.querySelector<HTMLInputElement>("#theme-follow")!;
  const update = () => {
    followBox.checked = follow;
    dialog.querySelectorAll<HTMLElement>("[data-theme-choice]").forEach((b) => {
      const id = b.dataset.themeChoice!;
      // Following the system, both remembered choices stay marked.
      const chosen = follow
        ? id === lightChoice || id === darkChoice
        : id === selected;
      b.setAttribute("aria-pressed", String(chosen));
      b.dataset.slot =
        follow && chosen
          ? id === darkChoice && themes.find((t) => t.id === id)!.dark
            ? "深色"
            : "浅色"
          : "";
    });
  };
  /** Switch to `id` with the same care the picker takes (see below). */
  function switchTo(id: string, feedback?: HTMLElement) {
    if (id === selected) return;
    const root = document.documentElement;
    clearTimeout(colorTimer);
    const previous = themes.find((theme) => theme.id === selected)!;
    const next = themes.find((theme) => theme.id === id)!;
    if (!!previous.dark === !!next.dark) {
      root.classList.add("theme-changing");
      void getComputedStyle(root).backgroundColor;
      apply(next.id);
      colorTimer = window.setTimeout(
        () => root.classList.remove("theme-changing"),
        280,
      );
    } else {
      root.classList.remove("theme-changing");
      root.classList.add("theme-contrast-switch");
      apply(next.id);
      void root.offsetWidth;
      root.classList.remove("theme-contrast-switch");
      if (feedback) animateContent(feedback, { distance: 0, duration: 180 });
    }
    update();
  }
  followBox.addEventListener("change", () => {
    follow = followBox.checked;
    writeSetting("ting.theme-follow", follow ? "1" : "0");
    // A dark palette picked before becomes the dark half of the pair.
    if (follow && !valid(lightChoice, false)) {
      darkChoice = lightChoice;
      lightChoice = "sage";
      writeSetting("ting.theme-dark", darkChoice);
      writeSetting("ting.theme", lightChoice);
    }
    switchTo(wanted());
    update();
  });
  systemDark.addEventListener("change", () => {
    if (follow) switchTo(wanted());
  });
  dialog.querySelector<HTMLButtonElement>("#theme-close")!.onclick = () =>
    closeDialog(dialog);
  dialog.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>(
      "[data-theme-choice]",
    );
    if (!b) return;
    if (follow) {
      // A dark palette fills the dark slot, a light one the light slot.
      const picked = themes.find((t) => t.id === b.dataset.themeChoice)!;
      if (picked.dark) darkChoice = picked.id;
      else lightChoice = picked.id;
      writeSetting(picked.dark ? "ting.theme-dark" : "ting.theme", picked.id);
      switchTo(wanted(), b.querySelector<HTMLElement>(".theme-preview")!);
      update();
      return;
    }
    if (b.dataset.themeChoice === selected) return;
    const root = document.documentElement;
    clearTimeout(colorTimer);
    const previous = themes.find((theme) => theme.id === selected)!;
    const next = themes.find((theme) => theme.id === b.dataset.themeChoice)!;
    if (!!previous.dark === !!next.dark) {
      root.classList.add("theme-changing");
      // Establish transition properties before changing the theme variables.
      void getComputedStyle(root).backgroundColor;
      apply(next.id);
      update();
      colorTimer = window.setTimeout(
        () => root.classList.remove("theme-changing"),
        280,
      );
    } else {
      // Interpolating light ink against a dark-to-light surface passes through
      // unreadable middle colors. Commit both sides of that change together,
      // including the ordinary button/row color transitions in the main UI.
      root.classList.remove("theme-changing");
      root.classList.add("theme-contrast-switch");
      apply(next.id);
      update();
      void root.offsetWidth;
      root.classList.remove("theme-contrast-switch");
      // Keep feedback on the decorative swatch; text remains fully opaque.
      animateContent(b.querySelector<HTMLElement>(".theme-preview")!, {
        distance: 0,
        duration: 180,
      });
    }
    lightChoice = selected;
    try {
      localStorage.setItem("ting.theme", selected);
    } catch {}
  });
  document.querySelector<HTMLButtonElement>("#theme-button")!.onclick = () => {
    update();
    openDialog(dialog);
  };
}
